const got = require('got')
const k8s = require('@kubernetes/client-node')

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

const podTemplate = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
        // name: "k8s-client-test",
        labels: {
            // name: "k8s-client-test",
            nodered: 'true'
            // app: "k8s-client-test",
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
                    request: {
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
                    { name: 'web', containerPort: 1880, protocol: 'TCP' }
                ],
                securityContext: {
                    allowPrivilegeEscalation: false
                }
            }
        ]
        // nodeSelector: {
        //     role: 'projects'
        // }

    },
    enableServiceLinks: false
}

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
                            request: {
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
        type: 'NodePort',
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
    if (!project.url) {
        projectURL = `${baseURL.protocol}//${project.safeName}.${this._options.domain}`
    } else {
        projectURL = project.url
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

    const credentialSecret = await project.getSetting('credentialSecret')
    if (credentialSecret) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_NR_SECRET', value: credentialSecret })
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

    if (stack.memory && stack.cpu) {
        localPod.spec.containers[0].resources.request.memory = `${stack.memory}Mi`
        localPod.spec.containers[0].resources.limits.memory = `${stack.memory}Mi`
        localPod.spec.containers[0].resources.request.cpu = `${stack.cpu * 10}m`
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

    // process annotations with potential replacements
    Object.keys(localIngress.metadata.annotations).forEach((key) => {
        localIngress.metadata.annotations[key] = mustache(localIngress.metadata.annotations[key], exposedData)
    })

    localIngress.metadata.name = project.safeName
    localIngress.spec.rules[0].host = url.host
    localIngress.spec.rules[0].http.paths[0].backend.service.name = `${prefix}${project.safeName}`

    return localIngress
}

const createProject = async (project, options) => {
    const namespace = this._app.config.driver.options.projectNamespace || 'flowforge'

    const localDeployment = await createDeployment(project, options)
    const localService = await createService(project, options)
    const localIngress = await createIngress(project, options)

    const promises = []
    promises.push(this._k8sAppApi.createNamespacedDeployment(namespace, localDeployment).catch(err => {
        this._app.log.error(`[k8s] Project ${project.id} - error creating deployment: ${err.toString()}`)
        this._app.log.error(`[k8s] deployment ${JSON.stringify(localDeployment, undefined, 2)}`)
        this._app.log.error(err)
        // rethrow the error so the wrapper knows this hasn't worked
        throw err
    }))
    /* eslint n/handle-callback-err: "off" */
    promises.push(this._k8sApi.createNamespacedService(namespace, localService).catch(err => {
        // TODO: This will fail if the service already exists. Which it okay if
        // we're restarting a suspended project. As we don't know if we're restarting
        // or not, we don't know if this is fatal or not.

        // Once we can know if this is a restart or create, then we can decide
        // whether to throw this error or not. For now, this will silently
        // let it pass
        //
        if (project.state !== 'suspended') {
            this._app.log.error(`[k8s] Project ${project.id} - error creating service: ${err.toString()}`)
        }
        // throw err
    }))

    // if (project.changedName) {
    //     promises.push(this._k8sNetApi.replaceNamespacedIngress(project.safeName,namespace, localIngress)).catch(err => {
    //         this._app.log.error(`[k8s] Project ${project.id} - error updating ingress: ${err.toString()}`)
    //     }).then (async () => {
    //         this._app.log.info(`[k8s] Ingress for project ${project.id} updated`)
    //     })
    // } else {
    promises.push(this._k8sNetApi.createNamespacedIngress(namespace, localIngress).catch(err => {
        // TODO: This will fail if the service already exists. Which it okay if
        // we're restarting a suspended project. As we don't know if we're restarting
        // or not, we don't know if this is fatal or not.

        // Once we can know if this is a restart or create, then we can decide
        // whether to throw this error or not. For now, this will silently
        // let it pass
        //
        if (project.state !== 'suspended') {
            this._app.log.error(`[k8s] Project ${project.id} - error creating ingress: ${err.toString()}`)
        }
        // throw err
    }).then(async () => {
        this._app.log.info(`[k8s] Ingress creation completed for project ${project.id}`)
    }))
    // }

    await project.updateSetting('k8sType', 'deployment')

    return Promise.all(promises).then(async () => {
        this._app.log.debug(`[k8s] Container ${project.id} started`)
        project.state = 'running'
        await project.save()
        this._projects[project.id].state = 'starting'
    })
}

// eslint-disable-next-line no-unused-vars
const createPod = async (project, options) => {
    // const namespace = this._app.config.driver.options.projectNamespace || 'flowforge'
    const stack = project.ProjectStack.properties

    const localPod = JSON.parse(JSON.stringify(podTemplate))
    localPod.metadata.name = project.safeName
    localPod.metadata.labels.name = project.safeName
    localPod.metadata.labels.app = project.id
    if (stack.container) {
        localPod.spec.containers[0].image = stack.container
    } else {
        localPod.spec.containers[0].image = `${this._options.registry}flowforge/node-red`
    }

    const baseURL = new URL(this._app.config.base_url)
    const projectURL = `${baseURL.protocol}//${project.safeName}.${this._options.domain}`
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

    const credentialSecret = await project.getSetting('credentialSecret')
    if (credentialSecret) {
        localPod.spec.containers[0].env.push({ name: 'FORGE_NR_SECRET', value: credentialSecret })
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

    if (stack.memory && stack.cpu) {
        localPod.spec.containers[0].resources.request.memory = `${stack.memory}Mi`
        localPod.spec.containers[0].resources.limits.memory = `${stack.memory}Mi`
        localPod.spec.containers[0].resources.request.cpu = `${stack.cpu * 10}m`
        localPod.spec.containers[0].resources.limits.cpu = `${stack.cpu * 10}m`
    }

    project.url = projectURL
    await project.save()

    return localPod
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

        this._namespace = this._app.config.driver.options.projectNamespace || 'flowforge'

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
            const namespace = options.projectNamespace || 'flowforge'
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
                            this._app.log.debug(`[k8s] Project ${project.id} - recreating deployment`)
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
                        label: 'CPU Cores (%)',
                        validate: '^([1-9][0-9]?|100)$',
                        invalidMessage: 'Invalid value - must be a number between 1 and 100',
                        description: 'How much of a single CPU core each Project should receive'
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
        // Stop the project, but don't remove all of its resources.
        this._projects[project.id].state = 'stopping'

        try {
            await this._k8sNetApi.deleteNamespacedIngress(project.safeName, this._namespace)
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting ingress: ${err.toString()}`)
        }
        if (project.safeName.match(/^[0-9]/)) {
            try {
                await this._k8sApi.deleteNamespacedService('srv-' + project.safeName, this._namespace)
            } catch (err) {
                this._app.log.error(`[k8s] Project ${project.id} - error deleting service: ${err.toString()}`)
            }
        } else {
            try {
                await this._k8sApi.deleteNamespacedService(project.safeName, this._namespace)
            } catch (err) {
                this._app.log.error(`[k8s] Project ${project.id} - error deleting service: ${err.toString()}`)
            }
        }

        // For now, we just want to remove the Pod/Deployment
        const currentType = await project.getSetting('k8sType')
        let pod = true
        if (currentType === 'deployment') {
            await this._k8sAppApi.deleteNamespacedDeployment(project.safeName, this._namespace)
            pod = false
        } else {
            await this._k8sApi.deleteNamespacedPod(project.safeName, this._namespace)
        }

        this._projects[project.id].state = 'suspended'
        return new Promise(resolve => {
            const pollInterval = setInterval(async () => {
                try {
                    if (pod) {
                        await this._k8sApi.readNamespacedPodStatus(project.safeName, this._namespace)
                    } else {
                        await this._k8sAppApi.readNamespacedDeployment(project.safeName, this._namespace)
                    }
                } catch (err) {
                    clearInterval(pollInterval)
                    resolve()
                }
            }, 1000)
        })
    },

    /**
     * Removes a Project
     * @param {Project} project - the project model instance
     * @return {Object}
     */
    remove: async (project) => {
        // let project = await this._app.db.models.Project.byId(id)

        try {
            await this._k8sNetApi.deleteNamespacedIngress(project.safeName, this._namespace)
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting ingress: ${err.toString()}`)
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
            container: 'flowforge/node-red',
            ...this._app.config.driver.options?.default_stack
        }

        return properties
    }
}
