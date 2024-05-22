const got = require('got')
const k8s = require('@kubernetes/client-node')
const _ = require('lodash')

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

const deploymentTemplate = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
        // name: "k8s-client-test-deployment",
        labels: {
            // name: "k8s-client-test-deployment",
            nodered: 'true'
            // app: "k8s-client-test-deployment"
        }
    },
    spec: {
        replicas: 1,
        selector: {
            matchLabels: {
                // app: "k8s-client-test-deployment"
            }
        },
        template: {
            metadata: {
                labels: {
                    // name: "k8s-client-test-deployment",
                    nodered: 'true'
                    // app: "k8s-client-test-deployment"
                }
            },
            spec: {
                securityContext: {
                    runAsUser: 1000,
                    runAsGroup: 1000,
                    fsGroup: 1000
                },
                containers: [
                    {
                        resources: {
                            requests: {
                                // 10th of a core
                                cpu: '100m',
                                memory: '128Mi'
                            },
                            limits: {
                                cpu: '125m',
                                memory: '192Mi'
                            }
                        },
                        name: 'node-red',
                        // image: "docker-pi.local:5000/bronze-node-red",
                        imagePullPolicy: 'Always',
                        env: [
                            // {name: "APP_NAME", value: "test"},
                            { name: 'TZ', value: 'Europe/London' }
                        ],
                        ports: [
                            { name: 'web', containerPort: 1880, protocol: 'TCP' },
                            { name: 'management', containerPort: 2880, protocol: 'TCP' }
                        ],
                        securityContext: {
                            allowPrivilegeEscalation: false
                        }
                    }
                ]
            },
            enableServiceLinks: false
        }
    }
}

const serviceTemplate = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
        // name: "k8s-client-test-service"
    },
    spec: {
        type: 'ClusterIP',
        selector: {
            // name: "k8s-client-test"
        },
        ports: [
            { name: 'web', port: 1880, protocol: 'TCP' },
            { name: 'management', port: 2880, protocol: 'TCP' }
        ]
    }
}

const ingressTemplate = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
        // name: "k8s-client-test-ingress",
        // namespace: 'flowforge',
        annotations: process.env.INGRESS_ANNOTATIONS ? JSON.parse(process.env.INGRESS_ANNOTATIONS) : {}
    },
    spec: {
        ingressClassName: process.env.INGRESS_CLASS_NAME ? process.env.INGRESS_CLASS_NAME : null,
        rules: [
            {
                // host: "k8s-client-test" + "." + "ubuntu.local",
                http: {
                    paths: [
                        {
                            pathType: 'Prefix',
                            path: '/',
                            backend: {
                                service: {
                                    // name: 'k8s-client-test-service',
                                    port: { number: 1880 }
                                }
                            }
                        }
                    ]
                }
            }
        ]
    }
}

const customIngressTemplate = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
        annotations: {}
    },
    spec: {
        rules: [
            {
                http: {
                    paths: [
                        {
                            pathType: 'Prefix',
                            path: '/',
                            backend: {
                                service: {
                                    port: { number: 1880 }
                                }
                            }
                        }
                    ]
                }
            }
        ],
        tls: [

        ]
    }
}

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
            this._app.log.info(`DEPLOYMENT TOLERATIONS loaded: ${localPod.spec.tolerations}`)
        } catch (err) {
            this._app.log.error(`TOLERATIONS load error: ${err}`)
        }
    }

    localPod.metadata.labels.app = project.id
    localPod.metadata.labels.name = project.safeName
    localPod.spec.serviceAccount = process.env.EDITOR_SERVICE_ACCOUNT

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

    if (this._app.config.driver.options.privateCA) {
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

    if (this._app.license.active() && this._cloudProvider === 'openshift') {
        localPod.spec.securityContext = {}
    }

    if (stack.memory && stack.cpu) {
        localPod.spec.containers[0].resources.requests.memory = `${stack.memory}Mi`
        // increase limit to give npm more room to run in
        localPod.spec.containers[0].resources.limits.memory = `${parseInt(stack.memory) + 128}Mi`
        localPod.spec.containers[0].resources.requests.cpu = `${stack.cpu * 10}m`
        localPod.spec.containers[0].resources.limits.cpu = `${stack.cpu * 10}m`
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

    if (this._certManagerIssuer) {
        localIngress.metadata.annotations['cert-manager.io/cluster-issuer'] = this._certManagerIssuer
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
        localIngress.metadata.annotations[key] = mustache(localIngress.metadata.annotations[key], exposedData)
    })

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

    if (this._customHostname?.certManagerIssuer) {
        customIngress.metadata.annotations['cert-manager.io/cluster-issuer'] = this._certManagerIssuer
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

    console.log(JSON.stringify(customIngress))

    return customIngress
}

const createProject = async (project, options) => {
    const namespace = this._app.config.driver.options.projectNamespace || 'flowforge'

    const localDeployment = await createDeployment(project, options)
    const localService = await createService(project, options)
    const localIngress = await createIngress(project, options)

    try {
        await this._k8sAppApi.createNamespacedDeployment(namespace, localDeployment)
    } catch (err) {
        if (err.statusCode === 409) {
            // If deployment exists, perform an upgrade
            this._app.log.warn(`[k8s] Deployment for project ${project.id} already exists. Upgrading deployment`)
            const result = await this._k8sAppApi.readNamespacedDeployment(project.safeName, namespace)

            const existingDeployment = result.body
            // Check if the metadata and spec are aligned. They won't be though (at minimal because we regenerate auth)
            if (!_.isEqual(existingDeployment.metadata, localDeployment.metadata) || !_.isEqual(existingDeployment.spec, localDeployment.spec)) {
                // If not aligned, replace the deployment
                await this._k8sAppApi.replaceNamespacedDeployment(project.safeName, namespace, localDeployment)
            }
        } else {
            // Log other errors and rethrow them for additional higher-level handling
            this._app.log.error(`[k8s] Unexpected error creating deployment for project ${project.id}.`)
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
                await this._k8sAppApi.readNamespacedDeployment(project.safeName, this._namespace)
                clearInterval(pollInterval)
                resolve()
            } catch (err) {
                // hmm
                counter++
                if (counter > this._k8sRetries) {
                    clearInterval(pollInterval)
                    this._app.log.error(`[k8s] Project ${project.id} - timeout waiting for Deployment`)
                    reject(new Error('Timed out to creating Deployment'))
                }
            }
        }, this._k8sDelay)
    })

    try {
        await this._k8sApi.createNamespacedService(namespace, localService)
    } catch (err) {
        if (err.statusCode === 409) {
            this._app.log.warn(`[k8s] Service for project ${project.id} already exists, proceeding...`)
        } else {
            if (project.state !== 'suspended') {
                this._app.log.error(`[k8s] Project ${project.id} - error creating service: ${err.toString()}`)
                throw err
            }
        }
    }

    const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
    await new Promise((resolve, reject) => {
        let counter = 0
        const pollInterval = setInterval(async () => {
            try {
                await this._k8sApi.readNamespacedService(prefix + project.safeName, this._namespace)
                clearInterval(pollInterval)
                resolve()
            } catch (err) {
                counter++
                if (counter > this._k8sRetries) {
                    clearInterval(pollInterval)
                    this._app.log.error(`[k8s] Project ${project.id} - timeout waiting for Service`)
                    reject(new Error('Timed out to creating Service'))
                }
            }
        }, this._k8sDelay)
    })

    try {
        await this._k8sNetApi.createNamespacedIngress(namespace, localIngress)
    } catch (err) {
        if (err.statusCode === 409) {
            this._app.log.warn(`[k8s] Ingress for project ${project.id} already exists, proceeding...`)
        } else {
            if (project.state !== 'suspended') {
                this._app.log.error(`[k8s] Project ${project.id} - error creating ingress: ${err.toString()}`)
                throw err
            }
        }
    }
    if (this._customHostname?.enabled) {
        const customHostname = await project.getSetting('customHostname')
        if (customHostname) {
            const customHostnameIngress = await createCustomIngress(project, customHostname, options)
            try {
                await this._k8sNetApi.createNamespacedIngress(namespace, customHostnameIngress)
            } catch (err) {
                if (err.statusCode === 409) {
                    this._app.log.warn(`[k8s] Custom Hostname Ingress for project ${project.id} already exists, proceeding...`)
                } else {
                    if (project.state !== 'suspended') {
                        this._app.log.error(`[k8s] Project ${project.id} - error creating custom hostname ingress: ${err.toString()}`)
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
                await this._k8sNetApi.readNamespacedIngress(project.safeName, this._namespace)
                clearInterval(pollInterval)
                resolve()
            } catch (err) {
                counter++
                if (counter > this._k8sRetries) {
                    clearInterval(pollInterval)
                    this._app.log.error(`[k8s] Project ${project.id} - timeout waiting for Ingress`)
                    reject(new Error('Timed out to creating Ingress'))
                }
            }
        }, this._k8sDelay)
    })

    await project.updateSetting('k8sType', 'deployment')

    this._app.log.debug(`[k8s] Container ${project.id} started`)
    project.state = 'running'
    await project.save()

    this._projects[project.id].state = 'starting'
}

const getEndpoints = async (project) => {
    const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
    if (await project.getSetting('ha')) {
        const endpoints = await this._k8sApi.readNamespacedEndpoints(`${prefix}${project.safeName}`, this._namespace)
        const addresses = endpoints.body.subsets[0].addresses.map(a => { return a.ip })
        const hosts = []
        for (const address in addresses) {
            hosts.push(addresses[address])
        }
        return hosts
    } else {
        return [`${prefix}${project.safeName}.${this._namespace}`]
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
        this._app = app
        this._projects = {}
        this._options = options

        this._namespace = this._app.config.driver.options?.projectNamespace || 'flowforge'
        this._k8sDelay = this._app.config.driver.options?.k8sDelay || 1000
        this._k8sRetries = this._app.config.driver.options?.k8sRetries || 10
        this._certManagerIssuer = this._app.config.driver.options?.certManagerIssuer
        this._logPassthrough = this._app.config.driver.options?.logPassthrough || false
        this._cloudProvider = this._app.config.driver.options?.cloudProvider
        if (this._app.config.driver.options?.customHostname?.enabled) {
            this._app.log.info('[k8s] Enabling Custom Hostname Support')
            this._customHostname = this._app.config.driver.options?.customHostname
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
        projects.forEach(async (project) => {
            if (this._projects[project.id] === undefined) {
                this._projects[project.id] = {
                    state: 'unknown'
                }
            }
        })

        this._initialCheckTimeout = setTimeout(() => {
            this._app.log.debug('[k8s] Restarting projects')
            const namespace = this._namespace
            projects.forEach(async (project) => {
                try {
                    if (project.state === 'suspended') {
                        // Do not restart suspended projects
                        return
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
                            this._app.log.info(`[k8s] Testing ${project.id} in ${namespace} deployment exists`)
                            await this._k8sAppApi.readNamespacedDeployment(project.safeName, namespace)
                            this._app.log.info(`[k8s] deployment ${project.id} in ${namespace} found`)
                        } catch (err) {
                            this._app.log.error(`[k8s] Error while reading namespaced deployment for project '${project.safeName}' ${project.id}.  Error msg=${err.message}, stack=${err.stack}`)
                            this._app.log.info(`[k8s] Project ${project.id} - recreating deployment`)
                            const fullProject = await this._app.db.models.Project.byId(project.id)
                            await createProject(fullProject, options)
                        }
                    } else {
                        try {
                            // pod already running
                            this._app.log.info(`[k8s] Testing ${project.id} in ${namespace} pod exists`)
                            await this._k8sApi.readNamespacedPodStatus(project.safeName, namespace)
                            this._app.log.info(`[k8s] pod ${project.id} in ${namespace} found`)
                        } catch (err) {
                            this._app.log.debug(`[k8s] Project ${project.id} - recreating deployment`)
                            const fullProject = await this._app.db.models.Project.byId(project.id)
                            await createProject(fullProject, options)
                        }
                    }
                } catch (err) {
                    this._app.log.error(`[k8s] Project ${project.id} - error resuming project: ${err.stack}`)
                }
            })
        }, 1000)

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
                        // taken from https://stackoverflow.com/a/62964157
                        validate: '^(([a-z0-9]|[a-z0-9][a-z0-9\\-]*[a-z0-9])\\.)*([a-z0-9]|[a-z0-9][a-z0-9\\-]*[a-z0-9])(:[0-9]+\\/)?(?:[0-9a-z-]+[/@])(?:([0-9a-z-]+))[/@]?(?:([0-9a-z-]+))?(?::[a-z0-9\\.-]+)?$',
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
        this._projects[project.id] = {
            state: 'starting'
        }

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
        this._projects[project.id].state = 'stopping'

        try {
            await this._k8sNetApi.deleteNamespacedIngress(project.safeName, this._namespace)
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting ingress: ${err.toString()}`)
        }

        if (this._certManagerIssuer) {
            try {
                await this._k8sApi.deleteNamespacedSecret(project.safeName, this._namespace)
            } catch (err) {
                this._app.log.error(`[k8s] Project ${project.id} - error deleting tls secret: ${err.toString()}`)
            }
        }

        if (this._customHostname?.enabled) {
            try {
                await this._k8sNetApi.deleteNamespacedIngress(`${project.safeName}-custom`, this._namespace)
            } catch (err) {
                this._app.log.error(`[k8s] Project ${project.id} - error deleting custom ingress: ${err.toString()}`)
            }

            if (this._customHostname?.certManagerIssuer) {
                try {
                    await this._k8sApi.deleteNamespacedSecret(`${project.safeName}-custom`, this._namespace)
                } catch (err) {
                    this._app.log.error(`[k8s] Project ${project.id} - error deleting custom tls secret: ${err.toString()}`)
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
                        await this._k8sNetApi.readNamespacedIngress(project.safeName, this._namespace)
                    } catch (err) {
                        clearInterval(pollInterval)
                        resolve()
                    }
                    counter++
                    if (counter > this._k8sRetries) {
                        clearInterval(pollInterval)
                        this._app.log.error(`[k8s] Project ${project.id} - timed out deleting ingress`)
                        reject(new Error('Timed out to deleting Ingress'))
                    }
                }, this._k8sDelay)
            })
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - Ingress was not deleted: ${err.toString()}`)
        }

        const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
        try {
            await this._k8sApi.deleteNamespacedService(prefix + project.safeName, this._namespace)
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting service: ${err.toString()}`)
        }

        try {
            await new Promise((resolve, reject) => {
                let counter = 0
                const pollInterval = setInterval(async () => {
                    try {
                        await this._k8sApi.readNamespacedService(prefix + project.safeName, this._namespace)
                    } catch (err) {
                        clearInterval(pollInterval)
                        resolve()
                    }
                    counter++
                    if (counter > this._k8sRetries) {
                        clearInterval(pollInterval)
                        this._app.log.error(`[k8s] Project ${project.id} - timed deleting service`)
                        reject(new Error('Timed out to deleting Service'))
                    }
                }, this._k8sDelay)
            })
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - Service was not deleted: ${err.toString()}`)
        }

        const currentType = await project.getSetting('k8sType')
        let pod = true
        if (currentType === 'deployment') {
            await this._k8sAppApi.deleteNamespacedDeployment(project.safeName, this._namespace)
            pod = false
        } else {
            await this._k8sApi.deleteNamespacedPod(project.safeName, this._namespace)
        }

        this._projects[project.id].state = 'suspended'
        return new Promise((resolve, reject) => {
            let counter = 0
            const pollInterval = setInterval(async () => {
                try {
                    if (pod) {
                        await this._k8sApi.readNamespacedPodStatus(project.safeName, this._namespace)
                    } else {
                        await this._k8sAppApi.readNamespacedDeployment(project.safeName, this._namespace)
                    }
                    counter++
                    if (counter > this._k8sRetries) {
                        clearInterval(pollInterval)
                        this._app.log.error(`[k8s] Project ${project.id} - timed deleting ${pod ? 'Pod' : 'Deployment'}`)
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
            await this._k8sNetApi.deleteNamespacedIngress(project.safeName, this._namespace)
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting ingress: ${err.toString()}`)
        }
        if (this._certManagerIssuer) {
            try {
                await this._k8sApi.deleteNamespacedSecret(project.safeName, this._namespace)
            } catch (err) {
                this._app.log.error(`[k8s] Project ${project.id} - error deleting tls secret: ${err.toString()}`)
            }
        }
        if (this._customHostname?.enabled) {
            try {
                await this._k8sNetApi.deleteNamespacedIngress(`${project.safeName}-custom`, this._namespace)
            } catch (err) {
                this._app.log.error(`[k8s] Project ${project.id} - error deleting custom ingress: ${err.toString()}`)
            }
            if (this._customHostname?.certManagerIssuer) {
                try {
                    await this._k8sApi.deleteNamespacedSecret(`${project.safeName}-custom`, this._namespace)
                } catch (err) {
                    this._app.log.error(`[k8s] Project ${project.id} - error deleting custom tls secret: ${err.toString()}`)
                }
            }
        }
        try {
            if (project.safeName.match(/^[0-9]/)) {
                await this._k8sApi.deleteNamespacedService('srv-' + project.safeName, this._namespace)
            } else {
                await this._k8sApi.deleteNamespacedService(project.safeName, this._namespace)
            }
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting service: ${err.toString()}`)
        }
        const currentType = await project.getSetting('k8sType')
        try {
            // A suspended project won't have a pod to delete - but try anyway
            // just in case state has got out of sync
            if (currentType === 'deployment') {
                await this._k8sAppApi.deleteNamespacedDeployment(project.safeName, this._namespace)
            } else {
                await this._k8sApi.deleteNamespacedPod(project.safeName, this._namespace)
            }
        } catch (err) {
            if (project.state !== 'suspended') {
                if (currentType === 'deployment') {
                    this._app.log.error(`[k8s] Project ${project.id} - error deleting deployment: ${err.toString()}`)
                } else {
                    this._app.log.error(`[k8s] Project ${project.id} - error deleting pod: ${err.toString()}`)
                }
            }
        }
        delete this._projects[project.id]
    },
    /**
     * Retrieves details of a project's container
     * @param {Project} project - the project model instance
     * @return {Object}
     */
    details: async (project) => {
        if (this._projects[project.id] === undefined) {
            return { state: 'unknown' }
        }
        if (this._projects[project.id].state === 'suspended') {
            // We should only poll the launcher if we think it is running.
            // Otherwise, return our cached state
            return {
                state: this._projects[project.id].state
            }
        }
        const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
        // this._app.log.debug('checking actual pod, not cache')

        /** @type { { response: IncomingMessage, body: k8s.V1Deployment } } */
        let details
        const currentType = await project.getSetting('k8sType')
        try {
            if (currentType === 'deployment') {
                details = await this._k8sAppApi.readNamespacedDeployment(project.safeName, this._namespace)
                if (details.body.status?.conditions[0].status === 'False') {
                    // return "starting" status until pod it running
                    this._projects[project.id].state = 'starting'
                    return {
                        id: project.id,
                        state: 'starting',
                        meta: {}
                    }
                } else if (details.body.status?.conditions[0].status === 'True' &&
                    (details.body.status?.conditions[0].type === 'Available' ||
                        (details.body.status?.conditions[0].type === 'Progressing' && details.body.status?.conditions[0].reason === 'NewReplicaSetAvailable')
                    )) {
                    // not calling all endpoints for HA as they should be the same
                    const infoURL = `http://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/info`
                    try {
                        const info = JSON.parse((await got.get(infoURL)).body)
                        this._projects[project.id].state = info.state
                        return info
                    } catch (err) {
                        this._app.log.debug(`error getting state from project ${project.id}: ${err}`)
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
                        error: `Unexpected pod status '${details.body.status?.conditions[0]?.status}', type '${details.body.status?.conditions[0]?.type}'`,
                        meta: {}
                    }
                }
            } else {
                details = await this._k8sApi.readNamespacedPodStatus(project.safeName, this._namespace)
                if (details.body.status?.phase === 'Pending') {
                    // return "starting" status until pod it running
                    this._projects[project.id].state = 'starting'
                    return {
                        id: project.id,
                        state: 'starting',
                        meta: {}
                    }
                } else if (details.body.status?.phase === 'Running') {
                    // not calling all endpoints for HA as they should be the same
                    const infoURL = `http://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/info`
                    try {
                        const info = JSON.parse((await got.get(infoURL)).body)
                        this._projects[project.id].state = info.state
                        return info
                    } catch (err) {
                        this._app.log.debug(`error getting state from project ${project.id}: ${err}`)
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
                        error: `Unexpected pod status '${details.body.status?.phase}'`,
                        meta: {}
                    }
                }
            }
        } catch (err) {
            this._app.log.debug(`error getting pod status for project ${project.id}: ${err}`)
            return {
                id: project?.id,
                error: err,
                state: 'starting',
                meta: details?.body?.status
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
        settings.healthCheckInterval = await project.getSetting('healthCheckInterval')

        return settings
    },

    /**
     * Starts the flows
     * @param {Project} project - the project model instance
     * @return {forge.Status}
     */
    startFlows: async (project) => {
        if (this._projects[project.id] === undefined) {
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
        if (this._projects[project.id] === undefined) {
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
        if (this._projects[project.id] === undefined) {
            return { state: 'unknown' }
        }
        if (await project.getSetting('ha')) {
            const addresses = await getEndpoints(project)
            const logRequests = []
            for (const address in addresses) {
                logRequests.push(got.get(`http://${addresses[address]}:2880/flowforge/logs`).json())
            }
            const results = await Promise.all(logRequests)
            const combinedResults = results.flat(1)
            combinedResults.sort((a, b) => { return a.ts - b.ts })
            return combinedResults
        } else {
            const prefix = project.safeName.match(/^[0-9]/) ? 'srv-' : ''
            const result = await got.get(`http://${prefix}${project.safeName}.${this._namespace}:2880/flowforge/logs`).json()
            return result
        }
    },

    /**
     * Restarts the flows
     * @param {Project} project - the project model instance
     * @return {forge.Status}
     */
    restartFlows: async (project) => {
        if (this._projects[project.id] === undefined) {
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
        this._app.log.debug(`[k8s] Project ${project.id} - logging out node-red instance`)
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
    }
}
