const got = require('got')
const FormData = require('form-data')
// const k8s = require('@kubernetes/client-node')
const _ = require('lodash')
const awsEFS = require('./lib/aws-efs.js')
const { WebSocket } = require('ws')

const {
    deploymentTemplate,
    serviceTemplate,
    ingressTemplate,
    customIngressTemplate,
    persistentVolumeClaimTemplate,
    mqttSchemaAgentPodTemplate,
    mqttSchemaAgentServiceTemplate
} = require('./templates.js')

let k8s

/**
 * Kubernates Container driver
 *
 * Handles the creation and deletation of containers to back Projects
 *
 * This driver creates Projects backed by Kubernates
 *
 * @module kubernates
 * @memberof forge.containers.drivers
 *
 */

const createDeployment = async (project, options) => {
    const stack = project.ProjectStack.properties

    const localDeployment = JSON.parse(JSON.stringify(deploymentTemplate))
    const localPod = localDeployment.spec.template
    localDeployment.metadata.name = project.safeName
    localDeployment.metadata.labels.name = project.safeName
    localDeployment.metadata.labels.app = project.id
    localDeployment.spec.selector.matchLabels.app = project.id

    // Examples:
    // 1. With this affinity definitions we can skip toarations
    // affinity:
    //     nodeAffinity:
    //         requiredDuringSchedulingIgnoredDuringExecution:
    //             nodeSelectorTerms:
    //                 - matchExpressions:
    // - key: node-owner
    // operator: In
    // values:
    //     - streaming-services-transcribe

    // 2. With this affinity
    // preferredDuringSchedulingIgnoredDuringExecution:
    //     - weight: 100
    // preference:
    //     matchExpressions:
    //         - key: purpose
    // operator: In
    // values:
    //     - skills
    // ---> we need these tolerations
    // tolerations:
    //     - key: purpose
    // operator: Equal
    // value: skills
    // effect: NoSchedule
    if (process.env.DEPLOYMENT_TOLERATIONS !== undefined) {
        // TOLERATIONS
        try {
            localPod.spec.tolerations = JSON.parse(process.env.DEPLOYMENT_TOLERATIONS)
            this._app.log.info(`[k8s] DEPLOYMENT TOLERATIONS loaded: ${localPod.spec.tolerations}`)
        } catch (err) {
            this._app.log.error(`[k8s] TOLERATIONS load error: ${err}`)
        }
    }

    localPod.metadata.labels.app = project.id
    localPod.metadata.labels.name = project.safeName
    localPod.spec.serviceAccount = process.env.EDITOR_SERVICE_ACCOUNT

    if (this._schedulerName) {
        localPod.spec.schedulerName = this._schedulerName
    }

    if (stack.container) {
        localPod.spec.containers[0].image = stack.container
    } else {
        localPod.spec.containers[0].image = `${this._options.registry}flowforge/node-red`
    }

    const baseURL = new URL(this._app.config.base_url)
    let projectURL
    if (!project.url.startsWith('http')) {
        projectURL = `${baseURL.protocol}//${project.safeName}.${this._options.domain}`
    } else {
        const temp = new URL(project.url)
        projectURL = `${temp.protocol}//${temp.hostname}${temp.port ? ':' + temp.port : ''}`
    }

    const teamID = this._app.db.models.Team.encodeHashid(project.TeamId)
    const authTokens = await project.refreshAuthTokens()
    localPod.spec.containers[0].env.push({ name: 'FORGE_CLIENT_ID', value: authTokens.clientID })
    localPod.spec.containers[0].env.push({ name: 'FORGE_CLIENT_SECRET', value: authTokens.clientSecret })
    localPod.spec.containers[0].env.push({ name: 'FORGE_URL', value: this._app.config.api_url })
    localPod.spec.containers[0].env.push({ name: 'BASE_URL', value: projectURL })
    localPod.spec.containers[0].env.push({ name: 'FORGE_TEAM_ID', value: teamID })
    localPod.spec.containers[0].env.push({ name: 'FORGE_PROJECT_ID', value: project.id })
    localPod.spec.containers[0].env.push({ name: 'FORGE_PROJECT_TOKEN', value: authTokens.token })
    // Inbound connections for k8s disabled by default
    localPod.spec.containers[0].env.push({ name: 'FORGE_NR_NO_TCP_IN', value: 'true' }) // MVP. Future iteration could present this to YML or UI
    localPod.spec.containers[0].env.push({ name: 'FORGE_NR_NO_UDP_IN', value: 'true' }) // MVP. Future iteration could present this to YML or UI
    if (authTokens.broker) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_BROKER_URL', value: authTokens.broker.url })
        localPod.spec.containers[0].env.push({ name: 'FORGE_BROKER_USERNAME', value: authTokens.broker.username })
        localPod.spec.containers[0].env.push({ name: 'FORGE_BROKER_PASSWORD', value: authTokens.broker.password })
    }
    if (this._app.license.active()) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_LICENSE_TYPE', value: 'ee' })
    }
    if (stack.memory) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_MEMORY_LIMIT', value: `${stack.memory}` })
    }
    if (stack.cpu) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_CPU_LIMIT', value: `${stack.cpu}` })
    }

    const credentialSecret = await project.getSetting('credentialSecret')
    if (credentialSecret) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_NR_SECRET', value: credentialSecret })
    }

    if (this._logPassthrough) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_LOG_PASSTHROUGH', value: 'true' })
    }

    if (this._app.config.driver.options.projectSelector) {
        localPod.spec.nodeSelector = this._app.config.driver.options.projectSelector
    }
    if (this._app.config.driver.options.registrySecrets) {
        localPod.spec.imagePullSecrets = []
        this._app.config.driver.options.registrySecrets.forEach(sec => {
            const entry = {
                name: sec
            }
            localPod.spec.imagePullSecrets.push(entry)
        })
    }

    if (this._app.config.driver.options?.privateCA) {
        localPod.spec.containers[0].volumeMounts = [
            {
                name: 'cacert',
                mountPath: '/usr/local/ssl-certs',
                readOnly: true
            }
        ]
        localPod.spec.volumes = [
            {
                name: 'cacert',
                configMap: {
                    name: this._app.config.driver.options.privateCA
                }
            }
        ]
        localPod.spec.containers[0].env.push({ name: 'NODE_EXTRA_CA_CERTS', value: '/usr/local/ssl-certs/chain.pem' })
    }

    if (this._app.config.driver.options?.storage?.enabled) {
        const volMount = {
            name: 'persistence',
            mountPath: '/data/storage'
        }
        const vol = {
            name: 'persistence',
            persistentVolumeClaim: {
                claimName: `${project.id}-pvc`
            }
        }
        if (Array.isArray(localPod.spec.containers[0].volumeMounts)) {
            localPod.spec.containers[0].volumeMounts.push(volMount)
        } else {
            localPod.spec.containers[0].volumeMounts = [volMount]
        }
        if (Array.isArray(localPod.spec.volumes)) {
            localPod.spec.volumes.push(vol)
        } else {
            localPod.spec.volumes = [vol]
        }
    }

    if (this._app.config.driver.options?.podSecurityContext) {
        localPod.spec.securityContext = this._app.config.driver.options.podSecurityContext
        this._app.log.info(`[k8s] Using custom PodSecurityContext ${JSON.stringify(this._app.config.driver.options.podSecurityContext)}`)
    } else if (this._app.license.active() && this._cloudProvider === 'openshift') {
        localPod.spec.securityContext = {}
        this._app.log.info('[k8s] OpenShift, removing PodSecurityContext')
    }

    if (this._app.config.driver.options?.containerSecurityContext) {
        localPod.spec.containers[0].securityContext = this._app.config.driver.options.containerSecurityContext
        this._app.log.info(`[k8s] Using custom ContainerSecurityContext ${JSON.stringify(this._app.config.driver.options.containerSecurityContext)}`)
    } else if (this._app.license.active() && this._cloudProvider === 'openshift') {
        localPod.spec.containers[0].securityContext = {}
        this._app.log.info('[k8s] OpenShift, removing ContainerSecurityContext')
    }

    if (stack.memory && stack.cpu) {
        localPod.spec.containers[0].resources.requests.memory = `${stack.memory}Mi`
        // increase limit to give npm more room to run in
        localPod.spec.containers[0].resources.limits.memory = `${parseInt(stack.memory) + 128}Mi`
        localPod.spec.containers[0].resources.requests.cpu = `${stack.cpu * 10}m`
        localPod.spec.containers[0].resources.limits.cpu = `${stack.cpu * 10}m`
    }

    if (this._app.config.driver.options?.projectLabels) {
        localPod.metadata.labels = {
            ...localPod.metadata.labels,
            ...this._app.config.driver.options.projectLabels
        }
        localDeployment.metadata.labels = {
            ...localDeployment.metadata.labels,
            ...this._app.config.driver.options.projectLabels
        }
    }

    if (this._app.config.driver.options?.projectProbes?.livenessProbe) {
        localPod.spec.containers[0].livenessProbe = this._app.config.driver.options.projectProbes.livenessProbe
    }
    if (this._app.config.driver.options?.projectProbes?.readinessProbe) {
        localPod.spec.containers[0].readinessProbe = this._app.config.driver.options.projectProbes.readinessProbe
    }
    if (this._app.config.driver.options?.projectProbes?.startupProbe) {
        localPod.spec.containers[0].startupProbe = this._app.config.driver.options.projectProbes.startupProbe
    }

    const ha = await project.getSetting('ha')
    if (ha?.replicas > 1) {
        localDeployment.spec.replicas = ha.replicas
    }

    project.url = projectURL
    await project.save()

    return localDeployment
}

const createService = async (project, options) => {
    const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''

    const localService = JSON.parse(JSON.stringify(serviceTemplate))
    localService.metadata.name = `${prefix}${project.safeName}`
    localService.spec.selector.name = project.safeName
    const allowedServiceTypes = ['NodePort', 'ClusterIP']
    const serviceType = this._app.config.driver.options?.service?.type || 'ClusterIP'
    if (!allowedServiceTypes.includes(serviceType)) {
        throw new Error('Service type must be either NodePort or ClusterIP')
    }
    localService.spec.type = serviceType
    if (this._app.config.driver.options?.projectLabels) {
        localService.metadata.labels = this._app.config.driver.options.projectLabels
    }
    return localService
}

const mustache = (string, data = {}) =>
    Object.entries(data).reduce((res, [key, value]) => res.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value), string)

const createIngress = async (project, options) => {
    const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
    const url = new URL(project.url)

    // exposedData available for annotation replacements
    const exposedData = {
        serviceName: `${prefix}${project.safeName}`,
        instanceURL: url.href,
        instanceHost: url.host,
        instanceProtocol: url.protocol
    }

    this._app.log.info('K8S DRIVER: start parse ingress template')

    const localIngress = JSON.parse(JSON.stringify(ingressTemplate))

    let addIngressTls = false

    if (this._certManagerIssuer) {
        localIngress.metadata.annotations['cert-manager.io/cluster-issuer'] = this._certManagerIssuer
        addIngressTls = true

        // Add non-cert-manager annotations from projectIngressAnnotations if they exist
        if (this._projectIngressAnnotations) {
            Object.keys(this._projectIngressAnnotations).forEach((key) => {
                if (!key.startsWith('cert-manager.io/')) {
                    localIngress.metadata.annotations[key] = this._projectIngressAnnotations[key]
                }
            })
        }
    } else if (this._projectIngressAnnotations) {
        const hasCertManagerAnnotation = Object.keys(this._projectIngressAnnotations).some(key =>
            key.startsWith('cert-manager.io/')
        )

        if (hasCertManagerAnnotation) {
            addIngressTls = true
        }

        // Add all annotations from projectIngressAnnotations
        Object.keys(this._projectIngressAnnotations).forEach((key) => {
            localIngress.metadata.annotations[key] = this._projectIngressAnnotations[key]
        })
    }

    // Add TLS configuration if needed
    if (addIngressTls) {
        localIngress.spec.tls = [
            {
                hosts: [
                    url.host
                ],
                secretName: project.safeName
            }
        ]
    }

    // process annotations with potential replacements
    Object.keys(localIngress.metadata.annotations).forEach((key) => {
        localIngress.metadata.annotations[key] = mustache(`${localIngress.metadata.annotations[key]}`, exposedData)
    })

    if (this._app.config.driver.options?.projectLabels) {
        localIngress.metadata.labels = this._app.config.driver.options.projectLabels
    }

    localIngress.metadata.name = project.safeName
    localIngress.spec.rules[0].host = url.host
    localIngress.spec.rules[0].http.paths[0].backend.service.name = `${prefix}${project.safeName}`

    return localIngress
}

const createCustomIngress = async (project, hostname, options) => {
    const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
    const url = new URL(project.url)
    url.host = hostname

    // exposedData available for annotation replacements
    const exposedData = {
        serviceName: `${prefix}${project.safeName}`,
        instanceURL: url.href,
        instanceHost: url.host,
        instanceProtocol: url.protocol
    }

    this._app.log.info('K8S DRIVER: start custom hostname ingress template')
    const customIngress = JSON.parse(JSON.stringify(customIngressTemplate))

    customIngress.metadata.name = `${project.safeName}-custom`
    customIngress.spec.rules[0].host = hostname
    customIngress.spec.rules[0].http.paths[0].backend.service.name = `${prefix}${project.safeName}`

    let addCustomIngressTls = false

    if (this._customHostname?.certManagerIssuer) {
        customIngress.metadata.annotations['cert-manager.io/cluster-issuer'] = this._customHostname.certManagerIssuer
        addCustomIngressTls = true

        // Add non-cert-manager annotations from projectIngressAnnotations if they exist
        if (this._customHostname?.ingressAnnotations) {
            Object.keys(this._customHostname?.ingressAnnotations).forEach((key) => {
                if (!key.startsWith('cert-manager.io/')) {
                    customIngress.metadata.annotations[key] = this._customHostname?.ingressAnnotations[key]
                }
            })
        }
    } else if (this._customHostname?.ingressAnnotations) {
        const hasCertManagerAnnotation = Object.keys(this._customHostname?.ingressAnnotations).some(key =>
            key.startsWith('cert-manager.io/')
        )

        if (hasCertManagerAnnotation) {
            addCustomIngressTls = true
        }

        // Add all annotations from projectIngressAnnotations
        Object.keys(this._customHostname?.ingressAnnotations).forEach((key) => {
            customIngress.metadata.annotations[key] = this._customHostname?.ingressAnnotations[key]
        })
    }

    // Add TLS configuration if needed
    if (addCustomIngressTls) {
        customIngress.spec.tls = [
            {
                hosts: [
                    hostname
                ],
                secretName: `${project.safeName}-custom`
            }
        ]
    }

    // process annotations with potential replacements
    Object.keys(customIngress.metadata.annotations).forEach((key) => {
        customIngress.metadata.annotations[key] = mustache(customIngress.metadata.annotations[key], exposedData)
    })

    if (this._customHostname?.ingressClass) {
        customIngress.spec.ingressClassName = `${this._customHostname.ingressClass}`
    }

    if (this._app.config.driver.options?.projectLabels) {
        customIngress.metadata.labels = this._app.config.driver.options.projectLabels
    }

    return customIngress
}

const createPersistentVolumeClaim = async (project, options) => {
    const namespace = this._app.config.driver.options?.projectNamespace || 'flowforge'
    const pvc = JSON.parse(JSON.stringify(persistentVolumeClaimTemplate))

    const drvOptions = this._app.config.driver.options

    if (drvOptions?.storage?.storageClass) {
        pvc.spec.storageClassName = drvOptions.storage.storageClass
    } else if (drvOptions?.storage?.storageClassEFSTag) {
        pvc.spec.storageClassName = await awsEFS.lookupStorageClass(drvOptions?.storage?.storageClassEFSTag)
    }

    if (drvOptions?.storage?.size) {
        pvc.spec.resources.requests.storage = drvOptions.storage.size
    }

    pvc.metadata.namespace = namespace
    pvc.metadata.name = `${project.id}-pvc`
    pvc.metadata.labels = {
        'ff-project-id': project.id,
        'ff-project-name': project.safeName
    }
    if (this._app.config.driver.options?.projectLabels) {
        pvc.metadata.labels = {
            ...pvc.metadata.labels,
            ...this._app.config.driver.options.projectLabels
        }
    }
    console.log(`PVC: ${JSON.stringify(pvc, null, 2)}`)
    return pvc
}

const createProject = async (project, options) => {
    const namespace = this._app.config.driver.options.projectNamespace || 'flowforge'

    const localDeployment = await createDeployment(project, options)
    const localService = await createService(project, options)
    const localIngress = await createIngress(project, options)

    if (this._app.config.driver.options?.storage?.enabled) {
        const localPVC = await createPersistentVolumeClaim(project, options)
        // console.log(JSON.stringify(localPVC, null, 2))
        try {
            await this._k8sApi.createNamespacedPersistentVolumeClaim({ namespace, body: localPVC })
        } catch (err) {
            console.log(JSON.stringify(err))
            if (err.code === 409) {
                this._app.log.warn(`[k8s] PVC for instance ${project.id} already exists, proceeding...`)
            } else {
                if (project.state !== 'suspended') {
                    this._app.log.error(`[k8s] Instance ${project.id} - error creating PVC: ${err.toString()} ${err.code} ${err.stack}`)
                    // console.log(err)
                    throw err
                }
            }
        }
    }

    try {
        await this._k8sAppApi.createNamespacedDeployment({ namespace, body: localDeployment })
    } catch (err) {
        if (err.code === 409) {
            // If deployment exists, perform an upgrade
            this._app.log.warn(`[k8s] Deployment for instance ${project.id} already exists. Upgrading deployment`)
            const result = await this._k8sAppApi.readNamespacedDeployment({ name: project.safeName, namespace })

            const existingDeployment = result
            // Check if the metadata and spec are aligned. They won't be though (at minimal because we regenerate auth)
            if (!_.isEqual(existingDeployment.metadata, localDeployment.metadata) || !_.isEqual(existingDeployment.spec, localDeployment.spec)) {
                // If not aligned, replace the deployment
                await this._k8sAppApi.replaceNamespacedDeployment({ name: project.safeName, namespace, body: localDeployment })
            }
        } else {
            // Log other errors and rethrow them for additional higher-level handling
            this._app.log.error(`[k8s] Unexpected error creating deployment for instance ${project.id}.`)
            this._app.log.error(`[k8s] deployment ${JSON.stringify(localDeployment, undefined, 2)}`)
            this._app.log.error(err)
            // rethrow the error so the wrapper knows this hasn't worked
            throw err
        }
    }

    await new Promise((resolve, reject) => {
        let counter = 0
        const pollInterval = setInterval(async () => {
            try {
                await this._k8sAppApi.readNamespacedDeployment({ name: project.safeName, namespace: this._namespace })
                clearInterval(pollInterval)
                resolve()
            } catch (err) {
                // hmm
                counter++
                if (counter > this._k8sRetries) {
                    clearInterval(pollInterval)
                    this._app.log.error(`[k8s] Instance ${project.id} - timeout waiting for Deployment`)
                    reject(new Error('Timed out to creating Deployment'))
                }
            }
        }, this._k8sDelay)
    })

    try {
        await this._k8sApi.createNamespacedService({ namespace, body: localService })
    } catch (err) {
        if (err.code === 409) {
            this._app.log.warn(`[k8s] Service for instance ${project.id} already exists, proceeding...`)
        } else {
            if (project.state !== 'suspended') {
                this._app.log.error(`[k8s] Instance ${project.id} - error creating service: ${err.toString()}`)
                throw err
            }
        }
    }

    const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
    await new Promise((resolve, reject) => {
        let counter = 0
        const pollInterval = setInterval(async () => {
            try {
                await this._k8sApi.readNamespacedService({ name: prefix + project.safeName, namespace: this._namespace })
                clearInterval(pollInterval)
                resolve()
            } catch (err) {
                counter++
                if (counter > this._k8sRetries) {
                    clearInterval(pollInterval)
                    this._app.log.error(`[k8s] Instance ${project.id} - timeout waiting for Service`)
                    reject(new Error('Timed out to creating Service'))
                }
            }
        }, this._k8sDelay)
    })

    try {
        await this._k8sNetApi.createNamespacedIngress({ namespace, body: localIngress })
    } catch (err) {
        if (err.code === 409) {
            this._app.log.warn(`[k8s] Ingress for instance ${project.id} already exists, proceeding...`)
        } else {
            if (project.state !== 'suspended') {
                this._app.log.error(`[k8s] Instance ${project.id} - error creating ingress: ${err.toString()} ${err.stack}}`)
                throw err
            }
        }
    }
    if (this._customHostname?.enabled) {
        const customHostname = await project.getSetting('customHostname')
        if (customHostname) {
            const customHostnameIngress = await createCustomIngress(project, customHostname, options)
            try {
                await this._k8sNetApi.createNamespacedIngress({ namespace, body: customHostnameIngress })
            } catch (err) {
                if (err.code === 409) {
                    this._app.log.warn(`[k8s] Custom Hostname Ingress for instance ${project.id} already exists, proceeding...`)
                } else {
                    if (project.state !== 'suspended') {
                        this._app.log.error(`[k8s] Instance ${project.id} - error creating custom hostname ingress: ${err.toString()} ${err.stack}`)
                        throw err
                    }
                }
            }
        }
    }

    await new Promise((resolve, reject) => {
        let counter = 0
        const pollInterval = setInterval(async () => {
            try {
                await this._k8sNetApi.readNamespacedIngress({ name: project.safeName, namespace: this._namespace })
                clearInterval(pollInterval)
                resolve()
            } catch (err) {
                counter++
                if (counter > this._k8sRetries) {
                    clearInterval(pollInterval)
                    this._app.log.error(`[k8s] Instance ${project.id} - timeout waiting for Ingress`)
                    reject(new Error('Timed out to creating Ingress'))
                }
            }
        }, this._k8sDelay)
    })

    await project.updateSetting('k8sType', 'deployment')

    this._app.log.debug(`[k8s] Container ${project.id} started`)
    project.state = 'running'
    await project.save()

    const cachedProject = await this._projects.get(project.id)
    cachedProject.state = 'starting'
    await this._projects.set(project.id, cachedProject)
}

const getEndpoints = async (project) => {
    const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
    if (await project.getSetting('ha')) {
        const endpoints = await this._k8sApi.readNamespacedEndpoints({ name: `${prefix}${project.safeName}`, namespace: this._namespace })
        const addresses = endpoints.subsets[0].addresses.map(a => { return a.ip })
        const hosts = []
        for (const address in addresses) {
            hosts.push(addresses[address])
        }
        return hosts
    } else {
        return [`${prefix}${project.safeName}.${this._namespace}`]
    }
}

const getStaticFileUrl = async (instance, filePath) => {
    const prefix = instance.safeName.match(/^[0-9]/) ? 'srv-' : ''
    return `http://${prefix}${instance.safeName}.${this._namespace}:2880/flowforge/files/_/${encodeURIComponent(filePath)}`
}

const createMQTTTopicAgent = async (broker) => {
    const agent = broker.constructor.name === 'TeamBrokerAgent'
    this._app.log.info(`[k8s] Starting MQTT Schema agent ${agent ? 'team-broker' : broker.hashid} for ${broker.Team.hashid}`)
    const localPod = JSON.parse(JSON.stringify(mqttSchemaAgentPodTemplate))
    const localService = JSON.parse(JSON.stringify(mqttSchemaAgentServiceTemplate))

    const namespace = this._app.config.driver.options.projectNamespace || 'flowforge'

    const { token } = await broker.refreshAuthTokens()
    localPod.spec.containers[0].env.push({ name: 'FORGE_TEAM_TOKEN', value: token })
    localPod.spec.containers[0].env.push({ name: 'FORGE_URL', value: this._app.config.api_url })
    localPod.spec.containers[0].env.push({ name: 'FORGE_BROKER_ID', value: agent ? 'team-broker' : broker.hashid })
    localPod.spec.containers[0].env.push({ name: 'FORGE_TEAM_ID', value: broker.Team.hashid })
    if (agent) {
        // env vars must be strings not numbers
        localPod.spec.containers[0].env.push({ name: 'FORGE_TIMEOUT', value: '24' })
    }

    if (this._app.config.driver.options.projectSelector) {
        localPod.spec.nodeSelector = this._app.config.driver.options.projectSelector
    }

    if (this._schedulerName) {
        localPod.spec.schedulerName = this._schedulerName
    }

    localPod.metadata.name = `mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}`
    localPod.metadata.labels = {
        name: `mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${broker.hashid.toLowerCase()}`,
        team: broker.Team.hashid,
        broker: agent ? 'team-broker' : broker.hashid
    }
    localService.metadata.name = `mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}`
    localService.metadata.labels = {
        team: broker.Team.hashid,
        broker: agent ? 'team-broker' : broker.hashid
    }
    if (this._app.config.driver.options?.projectLabels) {
        localPod.metadata.labels = {
            ...localPod.metadata.labels,
            ...this._app.config.driver.options.projectLabels
        }
        localService.metadata.labels = {
            ...localService.metadata.labels,
            ...this._app.config.driver.options.projectLabels
        }
    }
    localService.spec.selector.name = `mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}`

    // TODO remove registry entry
    localPod.spec.containers[0].image = this._app.config.driver.options?.mqttSchemaContainer || `${this._app.config.driver.options.registry ? this._app.config.driver.options.registry + '/' : ''}flowfuse/mqtt-schema-agent`

    // console.log(JSON.stringify(localPod,null,2))
    // console.log(JSON.stringify(localService,null,2))
    try {
        console.log(namespace, localPod.metadata.name)
        await this._k8sApi.createNamespacedPod({ namespace, body: localPod })
        await this._k8sApi.createNamespacedService({ namespace, body: localService })
    } catch (err) {
        this._app.log.error(`[k8s] Problem creating MQTT Agent ${agent ? 'team-broker' : broker.hashid} in ${namespace} - ${err.toString()} ${err.stack}`)
    }
}

module.exports = {
    /**
    * Initialises this driver
    * @param {string} app - the Vue application
    * @param {object} options - A set of configuration options for the driver
    * @return {forge.containers.ProjectArguments}
    */
    init: async (app, options) => {
        try {
            k8s = await import('@kubernetes/client-node')
        } catch (err) {
            throw Error('Failed to load Kubernetes node client', { cause: err })
        }
        this._app = app
        this._projects = app.caches.getCache('driver-k8s-projects') // {}
        this._options = options

        this._namespace = this._app.config.driver.options?.projectNamespace || 'flowforge'
        this._k8sDelay = this._app.config.driver.options?.k8sDelay || 1000
        this._k8sRetries = this._app.config.driver.options?.k8sRetries || 10
        this._certManagerIssuer = this._app.config.driver.options?.certManagerIssuer
        this._projectIngressAnnotations = this._app.config.driver.options?.projectIngressAnnotations
        this._logPassthrough = this._app.config.driver.options?.logPassthrough || false
        this._cloudProvider = this._app.config.driver.options?.cloudProvider
        this._schedulerName = this._app.config.driver.options?.schedulerName
        if (this._app.config.driver.options?.customHostname?.enabled) {
            this._app.log.info('[k8s] Enabling Custom Hostname Support')
            this._customHostname = this._app.config.driver.options?.customHostname
        }

        if (this._cloudProvider === 'openshift' && !this._app.license.active()) {
            this._app.log.info('[k8s] OpenShift Cloud Provider set, but no Enterprise License')
        }

        const kc = new k8s.KubeConfig()

        options.registry = app.config.driver.options?.registry || '' // use docker hub registry

        if (options.registry !== '' && !options.registry.endsWith('/')) {
            options.registry += '/'
        }

        kc.loadFromDefault()

        this._k8sApi = kc.makeApiClient(k8s.CoreV1Api)
        this._k8sAppApi = kc.makeApiClient(k8s.AppsV1Api)
        this._k8sNetApi = kc.makeApiClient(k8s.NetworkingV1Api)

        // Get a list of all projects - with the absolute minimum of fields returned
        const projects = await app.db.models.Project.findAll({
            attributes: [
                'id',
                'name',
                'state',
                'ProjectStackId',
                'TeamId'
            ]
        })
        for (const project of projects) {
            if (await this._projects.get(project.id) === undefined) {
                await this._projects.set(project.id, {
                    state: 'unknown'
                })
            }
        }

        this._initialCheckTimeout = setTimeout(async () => {
            this._app.log.debug('[k8s] Restarting projects')
            const namespace = this._namespace
            for (const project of projects) {
                try {
                    if (project.state === 'suspended') {
                        // Do not restart suspended projects
                        const cachedProject = await this._projects.get(project.id)
                        cachedProject.state = 'suspened'
                        await this._projects.set(project.id, cachedProject)
                        continue
                    }

                    // need to upgrade bare pods to deployments

                    // try {
                    //     this._app.log.info(`[k8s] Testing ${project.id} in ${namespace} is bare pod`)
                    //     await this._k8sApi.readNamespacedPodStatus(project.safeName, namespace)
                    //     // should only get here is a bare pod exists
                    //     this._app.log.info(`[k8s] upgrading ${project.id} to deployment`)
                    //     const fullProject = await this._app.db.models.Project.byId(project.id)
                    //     const localDeployment = await createDeployment(fullProject, options)
                    //     this._k8sAppApi.createNamespacedDeployment(namespace, localDeployment)
                    //         .then(() => {
                    //             return this._k8sApi.deleteNamespacedPod(project.safeName, namespace)
                    //         })
                    //         .catch(err => {
                    //             this._app.log.error(`[k8s] failed to upgrade ${project.id} to deployment`)
                    //         })
                    //     // it's just been created, not need to check if it still exists in the next block
                    //     return
                    // } catch (err) {
                    //     // bare pod not found can move on
                    //     this._app.log.info(`[k8s] ${project.id} in ${namespace} is not bare pod`)
                    // }

                    // look for missing projects
                    const currentType = await project.getSetting('k8sType')
                    if (currentType === 'deployment') {
                        try {
                            this._app.log.info(`[k8s] Testing ${project.id} (${project.safeName}) in ${namespace} deployment exists`)
                            await this._k8sAppApi.readNamespacedDeployment({ name: project.safeName, namespace })
                            this._app.log.info(`[k8s] deployment ${project.id} in ${namespace} found`)
                        } catch (err) {
                            this._app.log.error(`[k8s] Error while reading namespaced deployment for project '${project.safeName}' ${project.id}.  Error msg=${err.message}, stack=${err.stack}`)
                            this._app.log.info(`[k8s] Instance ${project.id} - recreating deployment`)
                            const fullProject = await this._app.db.models.Project.byId(project.id)
                            await createProject(fullProject, options)
                        }
                    } else {
                        try {
                            // pod already running
                            this._app.log.info(`[k8s] Testing ${project.id} in ${namespace} pod exists`)
                            await this._k8sApi.readNamespacedPodStatus({ name: project.safeName, namespace })
                            this._app.log.info(`[k8s] pod ${project.id} in ${namespace} found`)
                        } catch (err) {
                            this._app.log.debug(`[k8s] Instance ${project.id} - recreating deployment`)
                            const fullProject = await this._app.db.models.Project.byId(project.id)
                            await createProject(fullProject, options)
                        }
                    }
                } catch (err) {
                    this._app.log.error(`[k8s] Instance ${project.id} - error resuming project: ${err.stack}`)
                }
            }

            // get list of all MQTTBrokers
            if (this._app.db.models.BrokerCredentials) {
                const brokers = await this._app.db.models.BrokerCredentials.findAll({
                    include: [{ model: this._app.db.models.Team }]
                })

                // Check restarting MQTT-Schema-Agent
                for (const broker of brokers) {
                    const agent = broker.constructor.name === 'TeamBrokerAgent'
                    if (broker.Team && broker.state === 'running') {
                        try {
                            this._app.log.info(`[k8s] Testing MQTT Agent ${agent ? 'team-broker' : broker.hashid} in ${namespace} pod exists`)
                            this._app.log.debug(`mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}`)
                            await this._k8sApi.readNamespacedPodStatus({ name: `mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}`, namespace })
                            this._app.log.info(`[k8s] MQTT Agent pod ${agent ? 'team-broker' : broker.hashid} in ${namespace} found`)
                        } catch (err) {
                            this._app.log.debug(`[k8s] MQTT Agent ${agent ? 'team-broker' : broker.hashid} - failed ${err.toString()}`)
                            this._app.log.debug(`[k8s] MQTT Agent ${agent ? 'team-broker' : broker.hashid} - recreating pod`)
                            await createMQTTTopicAgent(broker)
                        }
                    }
                }
            }
        }, Math.floor(1000 + (Math.random() * 5))) // space this out so if 2 instances running they shouldn't run at the same time

        // need to work out what we can expose for K8s
        return {
            stack: {
                properties: {
                    cpu: {
                        label: 'CPU Cores (in 1/100th units)',
                        validate: '^([1-9][0-9]{0,2}|1000)$',
                        invalidMessage: 'Invalid value - must be a number between 1 and 1000, where 100 represents 1 CPU core',
                        description: 'Defines the CPU resources each Project should receive, in units of 1/100th of a CPU core. 100 equates to 1 CPU core'
                    },
                    memory: {
                        label: 'Memory (MB)',
                        validate: '^[1-9]\\d*$',
                        invalidMessage: 'Invalid value - must be a number',
                        description: 'How much memory the container for each Project will be granted, recommended value 256'
                    },
                    container: {
                        label: 'Container Location',
                        // taken from https://stackoverflow.com/a/74073589
                        validate: '^((?:(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])(?:(?:\\.(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]))+)?(?::[0-9]+)?/)?[a-z0-9]+(?:(?:(?:[._]|__|[-]*)[a-z0-9]+)+)?(?:(?:/[a-z0-9]+(?:(?:(?:[._]|__|[-]*)[a-z0-9]+)+)?)+)?)(?::([\\w][\\w.-]{0,127}))?(?:@([A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*[:][[:xdigit:]]{32,}))?$',
                        invalidMessage: 'Invalid value - must be a Docker image',
                        description: 'Container image location, can include a tag'
                    }
                }
            }
        }
    },
    /**
     * Start a Project
     * @param {Project} project - the project model instance
     * @return {forge.containers.Project}
     */
    start: async (project) => {
        await this._projects.set(project.id, {
            state: 'starting'
        })

        // Rather than await this promise, we return it. That allows the wrapper
        // to respond to the create request much quicker and the create can happen
        // asynchronously.
        // If the create fails, the Project still exists but will be put in suspended
        // state (and taken out of billing if enabled).

        // Remember, this call is used for both creating a new project as well as
        // restarting an existing project
        // return createPod(project)
        return createProject(project, this._options)
    },

    /**
     * Stop a Project
     * @param {Project} project - the project model instance
     */
    stop: async (project) => {
        // Stop the project
        const cachedProject = await this._projects.get(project.id)
        cachedProject.state = 'stopping'
        await this._projects.set(project.id, cachedProject)

        try {
            await this._k8sNetApi.deleteNamespacedIngress({ name: project.safeName, namespace: this._namespace })
        } catch (err) {
            this._app.log.error(`[k8s] Instance ${project.id} - error deleting ingress: ${err.toString()} ${err.stack}`)
        }

        if (this._certManagerIssuer) {
            try {
                await this._k8sApi.deleteNamespacedSecret({ name: project.safeName, namespace: this._namespace })
            } catch (err) {
                this._app.log.error(`[k8s] Instance ${project.id} - error deleting tls secret: ${err.toString()} ${err.stack}`)
            }
        } else if (this._projectIngressAnnotations) {
            const hasCertManagerAnnotation = Object.keys(this._projectIngressAnnotations).some(key =>
                key.startsWith('cert-manager.io/')
            )
            if (hasCertManagerAnnotation) {
                try {
                    await this._k8sApi.deleteNamespacedSecret({ name: project.safeName, namespace: this._namespace })
                } catch (err) {
                    this._app.log.error(`[k8s] Instance ${project.id} - error deleting tls secret: ${err.toString()} ${err.stack}`)
                }
            }
        }

        if (this._customHostname?.enabled) {
            try {
                await this._k8sNetApi.deleteNamespacedIngress({ name: `${project.safeName}-custom`, namespace: this._namespace })
            } catch (err) {
                this._app.log.error(`[k8s] Instance ${project.id} - error deleting custom ingress: ${err.toString()} ${err.stack}`)
            }

            if (this._customHostname?.certManagerIssuer) {
                try {
                    await this._k8sApi.deleteNamespacedSecret({ name: `${project.safeName}-custom`, namespace: this._namespace })
                } catch (err) {
                    this._app.log.error(`[k8s] Instance ${project.id} - error deleting custom tls secret: ${err.toString()} ${err.stack}`)
                }
            }
        }

        // Note that, regardless, the main objective is to delete deployment (runnable)
        // Even if some k8s resources like ingress or service are still not deleted (maybe because of
        // k8s service latency), the most important thing is to get to deployment.
        try {
            await new Promise((resolve, reject) => {
                let counter = 0
                const pollInterval = setInterval(async () => {
                    try {
                        await this._k8sNetApi.readNamespacedIngress({ name: project.safeName, namespace: this._namespace })
                    } catch (err) {
                        clearInterval(pollInterval)
                        resolve()
                    }
                    counter++
                    if (counter > this._k8sRetries) {
                        clearInterval(pollInterval)
                        this._app.log.error(`[k8s] Instance ${project.id} - timed out deleting ingress`)
                        reject(new Error('Timed out to deleting Ingress'))
                    }
                }, this._k8sDelay)
            })
        } catch (err) {
            this._app.log.error(`[k8s] Instance ${project.id} - Ingress was not deleted: ${err.toString()}`)
        }

        const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
        try {
            await this._k8sApi.deleteNamespacedService({ name: prefix + project.safeName, namespace: this._namespace })
        } catch (err) {
            this._app.log.error(`[k8s] Instance ${project.id} - error deleting service: ${err.toString()} ${err.stack}`)
        }

        try {
            await new Promise((resolve, reject) => {
                let counter = 0
                const pollInterval = setInterval(async () => {
                    try {
                        await this._k8sApi.readNamespacedService({ name: prefix + project.safeName, namespace: this._namespace })
                    } catch (err) {
                        clearInterval(pollInterval)
                        resolve()
                    }
                    counter++
                    if (counter > this._k8sRetries) {
                        clearInterval(pollInterval)
                        this._app.log.error(`[k8s] Instance ${project.id} - timed deleting service`)
                        reject(new Error('Timed out to deleting Service'))
                    }
                }, this._k8sDelay)
            })
        } catch (err) {
            this._app.log.error(`[k8s] Instance ${project.id} - Service was not deleted: ${err.toString()} ${err.stack}`)
        }

        const currentType = await project.getSetting('k8sType')
        let pod = true
        if (currentType === 'deployment') {
            await this._k8sAppApi.deleteNamespacedDeployment({ name: project.safeName, namespace: this._namespace })
            pod = false
        } else {
            await this._k8sApi.deleteNamespacedPod({ name: project.safeName, namespace: this._namespace })
        }

        // We should not delete the PVC when the instance is suspended
        // if (this._app.config.driver.options?.storage?.enabled) {
        //     try {
        //         await this._k8sApi.deleteNamespacedPersistentVolumeClaim(`${project.safeName}-pvc`, this._namespace)
        //     } catch (err) {
        //         this._app.log.error(`[k8s] Instance ${project.id} - error deleting PVC: ${err.toString()} ${err.statusCode}`)
        //     }
        // }

        cachedProject.state = 'suspended'
        await this._projects.set(project.id, cachedProject)
        return new Promise((resolve, reject) => {
            let counter = 0
            const pollInterval = setInterval(async () => {
                try {
                    if (pod) {
                        await this._k8sApi.readNamespacedPodStatus({ name: project.safeName, namespace: this._namespace })
                    } else {
                        await this._k8sAppApi.readNamespacedDeployment({ name: project.safeName, namespace: this._namespace })
                    }
                    counter++
                    if (counter > this._k8sRetries) {
                        clearInterval(pollInterval)
                        this._app.log.error(`[k8s] Instance ${project.id} - timed deleting ${pod ? 'Pod' : 'Deployment'}`)
                        reject(new Error('Timed out to deleting Deployment'))
                    }
                } catch (err) {
                    clearInterval(pollInterval)
                    resolve()
                }
            }, this._k8sDelay)
        })
    },

    /**
     * Removes a Project
     * @param {Project} project - the project model instance
     * @return {Object}
     */
    remove: async (project) => {
        try {
            await this._k8sNetApi.deleteNamespacedIngress({ name: project.safeName, namespace: this._namespace })
        } catch (err) {
            this._app.log.error(`[k8s] Instance ${project.id} - error deleting ingress: ${err.toString()}`)
        }
        if (this._certManagerIssuer) {
            try {
                await this._k8sApi.deleteNamespacedSecret({ name: project.safeName, namespace: this._namespace })
            } catch (err) {
                this._app.log.error(`[k8s] Instance ${project.id} - error deleting tls secret: ${err.toString()}`)
            }
        } else if (this._projectIngressAnnotations) {
            const hasCertManagerAnnotation = Object.keys(this._projectIngressAnnotations).some(key =>
                key.startsWith('cert-manager.io/')
            )
            if (hasCertManagerAnnotation) {
                try {
                    await this._k8sApi.deleteNamespacedSecret({ name: project.safeName, namespace: this._namespace })
                } catch (err) {
                    this._app.log.error(`[k8s] Instance ${project.id} - error deleting tls secret: ${err.toString()}`)
                }
            }
        }
        if (this._customHostname?.enabled) {
            try {
                await this._k8sNetApi.deleteNamespacedIngress({ name: `${project.safeName}-custom`, namespace: this._namespace })
            } catch (err) {
                this._app.log.error(`[k8s] Instance ${project.id} - error deleting custom ingress: ${err.toString()}`)
            }
            if (this._customHostname?.certManagerIssuer || this._customHostname?.certManagerAnnotations) {
                try {
                    await this._k8sApi.deleteNamespacedSecret({ name: `${project.safeName}-custom`, namespace: this._namespace })
                } catch (err) {
                    this._app.log.error(`[k8s] Instance ${project.id} - error deleting custom tls secret: ${err.toString()}`)
                }
            }
        }
        try {
            if (project.safeName.match(/^[0-9]/)) {
                await this._k8sApi.deleteNamespacedService({ name: 'srv-' + project.safeName, namespace: this._namespace })
            } else {
                await this._k8sApi.deleteNamespacedService({ name: project.safeName, namespace: this._namespace })
            }
        } catch (err) {
            this._app.log.error(`[k8s] Instance ${project.id} - error deleting service: ${err.toString()}`)
        }
        const currentType = await project.getSetting('k8sType')
        try {
            // A suspended project won't have a pod to delete - but try anyway
            // just in case state has got out of sync
            if (currentType === 'deployment') {
                await this._k8sAppApi.deleteNamespacedDeployment({ name: project.safeName, namespace: this._namespace })
            } else {
                await this._k8sApi.deleteNamespacedPod({ name: project.safeName, namespace: this._namespace })
            }
        } catch (err) {
            if (project.state !== 'suspended') {
                if (currentType === 'deployment') {
                    this._app.log.error(`[k8s] Instance ${project.id} - error deleting deployment: ${err.toString()}`)
                } else {
                    this._app.log.error(`[k8s] Instance ${project.id} - error deleting pod: ${err.toString()}`)
                }
            }
        }
        if (this._app.config.driver.options?.storage?.enabled) {
            try {
                await this._k8sApi.deleteNamespacedPersistentVolumeClaim({ name: `${project.id}-pvc`, namespace: this._namespace })
            } catch (err) {
                this._app.log.error(`[k8s] Instance ${project.id} - error deleting PVC: ${err.toString()} ${err.code}`)
                // console.log(err)
            }
        }
        await this._projects.del(project.id)
    },
    /**
     * Retrieves details of a project's container
     * @param {Project} project - the project model instance
     * @return {Object}
     */
    details: async (project) => {
        const cachedProject = await this._projects.get(project.id)
        if (cachedProject === undefined) {
            return { state: 'unknown' }
        }
        if (cachedProject.state === 'suspended') {
            // We should only poll the launcher if we think it is running.
            // Otherwise, return our cached state
            return {
                state: cachedProject.state
            }
        }
        const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
        // this._app.log.debug('checking actual pod, not cache')

        /** @type { { response: IncomingMessage, body: k8s.V1Deployment } } */
        let details
        const currentType = await project.getSetting('k8sType')
        try {
            if (currentType === 'deployment') {
                details = await this._k8sAppApi.readNamespacedDeployment({ name: project.safeName, namespace: this._namespace })
                if (details.status?.conditions[0].status === 'False') {
                    // return "starting" status until pod it running
                    cachedProject.state = 'starting'
                    await this._projects.set(project.id, cachedProject)
                    return {
                        id: project.id,
                        state: 'starting',
                        meta: {}
                    }
                } else if (details.status?.conditions[0].status === 'True' &&
                    (details.status?.conditions[0].type === 'Available' ||
                        (details.status?.conditions[0].type === 'Progressing' && details.status?.conditions[0].reason === 'NewReplicaSetAvailable')
                    )) {
                    // not calling all endpoints for HA as they should be the same
                    const infoURL = `http://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/info`
                    try {
                        const info = JSON.parse((await got.get(infoURL, { timeout: { request: 1000 } })).body)
                        cachedProject.state = info.state
                        await this._projects.set(project.id, cachedProject)
                        return info
                    } catch (err) {
                        this._app.log.debug(`error getting state from instance ${project.id}: ${err}`)
                        return {
                            id: project.id,
                            state: 'starting',
                            meta: {}
                        }
                    }
                } else {
                    return {
                        id: project.id,
                        state: 'starting',
                        error: `Unexpected pod status '${details.status?.conditions[0]?.status}', type '${details.status?.conditions[0]?.type}'`,
                        meta: {}
                    }
                }
            } else {
                details = await this._k8sApi.readNamespacedPodStatus({ name: project.safeName, namespace: this._namespace })
                if (details.status?.phase === 'Pending') {
                    // return "starting" status until pod it running
                    cachedProject.state = 'starting'
                    this._projects.set(project.id, cachedProject)
                    return {
                        id: project.id,
                        state: 'starting',
                        meta: {}
                    }
                } else if (details.status?.phase === 'Running') {
                    // not calling all endpoints for HA as they should be the same
                    const infoURL = `http://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/info`
                    try {
                        const info = JSON.parse((await got.get(infoURL, { timeout: { request: 1000 } })).body)
                        cachedProject.state = info.state
                        await this._projects.set(project.id, cachedProject)
                        return info
                    } catch (err) {
                        this._app.log.debug(`error getting state from instance ${project.id}: ${err}`)
                        return {
                            id: project.id,
                            state: 'starting',
                            meta: {}
                        }
                    }
                } else {
                    return {
                        id: project.id,
                        state: 'starting',
                        error: `Unexpected pod status '${details.status?.phase}'`,
                        meta: {}
                    }
                }
            }
        } catch (err) {
            this._app.log.debug(`error getting pod status for instance ${project.id}: ${err} ${err.stack}`)
            return {
                id: project?.id,
                error: err,
                state: 'starting',
                meta: details?.status
            }
        }
    },

    /**
     * Returns the settings for the project
     * @param {Project} project - the project model instance
     */
    settings: async (project) => {
        const settings = {}
        settings.projectID = project.id
        settings.port = 1880
        settings.rootDir = '/'
        settings.userDir = 'data'

        return settings
    },

    /**
     * Starts the flows
     * @param {Project} project - the project model instance
     * @return {forge.Status}
     */
    startFlows: async (project) => {
        const cachedProject = await this._projects.get(project.id)
        if (cachedProject === undefined) {
            return { state: 'unknown' }
        }
        const endpoints = await getEndpoints(project)
        const commands = []
        for (const address in endpoints) {
            commands.push(got.post(`http://${endpoints[address]}:2880/flowforge/command`, {
                json: {
                    cmd: 'start'
                }
            }))
        }
        await Promise.all(commands)
        return { status: 'okay' }
    },

    /**
     * Stops the flows
     * @param {Project} project - the project model instance
     * @return {forge.Status}
     */
    stopFlows: async (project) => {
        const cachedProject = await this._projects.get(project.id)
        if (cachedProject === undefined) {
            return { state: 'unknown' }
        }
        const endpoints = await getEndpoints(project)
        const commands = []
        for (const address in endpoints) {
            commands.push(got.post(`http://${endpoints[address]}:2880/flowforge/command`, {
                json: {
                    cmd: 'stop'
                }
            }))
        }
        await Promise.all(commands)
        return Promise.resolve({ status: 'okay' })
    },

    /**
     * Get a Project's logs
     * @param {Project} project - the project model instance
     * @return {array} logs
     */
    logs: async (project) => {
        const cachedProject = await this._projects.get(project.id)
        if (cachedProject === undefined) {
            return { state: 'unknown' }
        }
        if (await project.getSetting('ha')) {
            const addresses = await getEndpoints(project)
            const logRequests = []
            for (const address in addresses) {
                logRequests.push(got.get(`http://${addresses[address]}:2880/flowforge/logs`, { timeout: { request: 2000 } }).json())
            }
            const results = await Promise.all(logRequests)
            const combinedResults = results.flat(1)
            combinedResults.sort((a, b) => { return a.ts - b.ts })
            return combinedResults
        } else {
            const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
            const result = await got.get(`http://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/logs`, { timeout: { request: 2000 } }).json()
            return result
        }
    },

    /**
     * Restarts the flows
     * @param {Project} project - the project model instance
     * @return {forge.Status}
     */
    restartFlows: async (project) => {
        const cachedProject = await this._projects.get(project.id)
        if (cachedProject === undefined) {
            return { state: 'unknown' }
        }
        const endpoints = await getEndpoints(project)
        const commands = []
        for (const address in endpoints) {
            commands.push(got.post(`http://${endpoints[address]}:2880/flowforge/command`, {
                json: {
                    cmd: 'restart'
                }
            }))
        }
        await Promise.all(commands)
        return { state: 'okay' }
    },
    /**
   * Logout Node-RED instance
   * @param {Project} project - the project model instance
   * @param {string} token - the node-red token to revoke
   * @return {forge.Status}
   */
    revokeUserToken: async (project, token) => { // logout:nodered(step-3)
        this._app.log.debug(`[k8s] Instance ${project.id} - logging out node-red instance`)
        const endpoints = await getEndpoints(project)
        const commands = []
        for (const address in endpoints) {
            commands.push(got.post(`http://${endpoints[address]}:2880/flowforge/command`, {
                json: {
                    cmd: 'logout',
                    token
                }
            }))
        }
        await Promise.all(commands)
    },
    /**
     * Shutdown Driver
     */
    shutdown: async () => {
        clearTimeout(this._initialCheckTimeout)
    },
    /**
     * getDefaultStackProperties
     */
    getDefaultStackProperties: () => {
        // need to work out what the right container tag is
        const properties = {
            cpu: 10,
            memory: 256,
            container: 'flowfuse/node-red',
            ...this._app.config.driver.options?.default_stack
        }

        return properties
    },

    // Static Assets API
    listFiles: async (instance, filePath) => {
        const fileUrl = await getStaticFileUrl(instance, filePath)
        try {
            return got.get(fileUrl, { timeout: { request: 1000 } }).json()
        } catch (err) {
            console.log(err)
            err.statusCode = err.response.statusCode
            throw err
        }
    },

    updateFile: async (instance, filePath, update) => {
        const fileUrl = await getStaticFileUrl(instance, filePath)
        try {
            return got.put(fileUrl, {
                json: update
            })
        } catch (err) {
            err.statusCode = err.response.statusCode
            throw err
        }
    },

    deleteFile: async (instance, filePath) => {
        const fileUrl = await getStaticFileUrl(instance, filePath)
        try {
            return got.delete(fileUrl)
        } catch (err) {
            err.statusCode = err.response.statusCode
            throw err
        }
    },
    createDirectory: async (instance, filePath, directoryName) => {
        const fileUrl = await getStaticFileUrl(instance, filePath)
        try {
            return got.post(fileUrl, {
                json: { path: directoryName }
            })
        } catch (err) {
            err.statusCode = err.response.statusCode
            throw err
        }
    },
    uploadFile: async (instance, filePath, fileBuffer) => {
        const form = new FormData()
        form.append('file', fileBuffer, { filename: filePath })
        const fileUrl = await getStaticFileUrl(instance, filePath)
        try {
            return got.post(fileUrl, {
                body: form
            })
        } catch (err) {
            err.statusCode = err.response.statusCode
            throw err
        }
    },

    // Broker Agent
    startBrokerAgent: async (broker) => {
        createMQTTTopicAgent(broker)
    },
    stopBrokerAgent: async (broker) => {
        const agent = broker.constructor.name === 'TeamBrokerAgent'
        try {
            await this._k8sApi.deleteNamespacedService({ name: `mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}`, namespace: this._namespace })
            await this._k8sApi.deleteNamespacedPod({ name: `mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}`, namespace: this._namespace })
        } catch (err) {
            this._app.log.error(`[k8s] Error deleting MQTT Agent ${agent ? 'team-broker' : broker.hashid}: ${err.toString()} ${err.code}`)
        }
    },
    getBrokerAgentState: async (broker) => {
        const agent = broker.constructor.name === 'TeamBrokerAgent'
        try {
            const status = await got.get(`http://mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}.${this._namespace}:3500/api/v1/status`, { timeout: { request: 1000 } }).json()
            return status
        } catch (err) {
            return { error: 'error_getting_status', message: err.toString() }
        }
    },
    sendBrokerAgentCommand: async (broker, command) => {
        const agent = broker.constructor.name === 'TeamBrokerAgent'
        if (command === 'start' || command === 'restart') {
            try {
                await got.post(`http://mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}.${this._namespace}:3500/api/v1/commands/start`, { timeout: { request: 1000 } })
            } catch (err) {

            }
        } else if (command === 'stop') {
            try {
                await got.post(`http://mqtt-schema-agent-${broker.Team.hashid.toLowerCase()}-${agent ? 'team-broker' : broker.hashid.toLowerCase()}.${this._namespace}:3500/api/v1/commands/stop`, { timeout: { request: 1000 } })
            } catch (err) {

            }
        }
    },

    // Resouces api
    resources: async (project) => {
        const cachedProject = await this._projects.get(project.id)
        if (cachedProject === undefined) {
            return { state: 'unknown' }
        }
        if (await project.getSetting('ha')) {
            const addresses = await getEndpoints(project)
            const logRequests = []
            for (const address in addresses) {
                logRequests.push(got.get(`http://${addresses[address]}:2880/flowforge/resources`).json())
            }
            const results = await Promise.all(logRequests)
            const combinedResults = results[0].resources.concat(results[1].resources)
            // const combinedResults = results.flat(1)
            combinedResults.sort((a, b) => { return a.ts - b.ts })
            return {
                meta: results[0].meta,
                resources: combinedResults,
                count: combinedResults.length
            }
        } else {
            const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
            const result = await got.get(`http://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/resources`, { timeout: { request: 2000 } }).json()
            if (Array.isArray(result)) {
                return {
                    meta: {},
                    resources: result,
                    count: result.length
                }
            } else {
                return result
            }
        }
    },
    resourcesStream: async (project, socket) => {
        const cachedProject = await this._projects.get(project.id)
        if (cachedProject === undefined) {
            throw new Error('Cannot get instance resources')
        }
        if (await project.getSetting('ha')) {
            const addresses = await getEndpoints(project)
            const resourceStreams = []
            for (const address in addresses) {
                const url = `ws://${addresses[address]}:2880/flowforge/resources`
                const resourceStream = new WebSocket(url, {})
                resourceStreams.push(resourceStream)
                resourceStream.on('message', (data) => {
                    socket.send(data)
                })
                resourceStream.on('error', (err) => {
                    this._app.log.error(`Error in resource stream: ${err}`)
                    socket.close()
                })
            }
            socket.on('close', () => {
                try {
                    resourceStreams.forEach((resourceStream) => {
                        if (resourceStream.readyState === WebSocket.OPEN) {
                            resourceStream.close()
                        }
                    })
                } catch (err) {
                    // logger.error(`Error closing resource stream: ${err}`)
                }
            })
        } else {
            const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
            const url = `ws://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/resources`
            const resourceStream = new WebSocket(url, {})
            resourceStream.on('message', (data) => {
                socket.send(data)
            })
            resourceStream.on('error', (err) => {
                this._app.log.error(`Error in resource stream: ${err}`)
                socket.close()
            })
            socket.on('close', () => {
                try {
                    resourceStream.close()
                } catch (err) {
                    // this._app.log.error(`Error closing resource stream: ${err}`)
                }
            })
            return resourceStream
        }
    }
}
