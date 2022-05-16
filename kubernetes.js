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
            // "pts-node-red": "bronze"
        }
    },
    spec: {
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
                ]
            }
        ],
        nodeSelector: {
            role: 'projects'
        }

    },
    enableServiceLinks: false
}

// const deploymentTemplate = {
//     apiVersion: 'apps/v1',
//     kind: 'Deployment',
//     metadata: {
//     // name: "k8s-client-test-deployment",
//         labels: {
//             // name: "k8s-client-test-deployment",
//             nodered: 'true'
//             // app: "k8s-client-test-deployment"
//         }
//     },
//     spec: {
//         replicas: 1,
//         selector: {
//             matchLabels: {
//                 // app: "k8s-client-test-deployment"
//             }
//         },
//         template: {
//             metadata: {
//                 labels: {
//                     // name: "k8s-client-test-deployment",
//                     nodered: 'true'
//                     // app: "k8s-client-test-deployment"
//                 }
//             },
//             spec: {
//                 containers: [
//                     {
//                         name: 'node-red',
//                         // image: "docker-pi.local:5000/bronze-node-red",
//                         env: [
//                             // {name: "APP_NAME", value: "test"},
//                             { name: 'TZ', value: 'Europe/London' }
//                         ],
//                         ports: [
//                             { name: 'web', containerPort: 1880, protocol: 'TCP' },
//                             { name: 'management', containerPort: 2880, protocol: 'TCP' }
//                         ]
//                     }
//                 ]
//             },
//             enableServiceLinks: false
//         }
//     }
// }

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
        annotations: {}
    },
    spec: {
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
                                    name: 'k8s-client-test-service',
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

const createPod = async (project, options) => {
    console.log('creating ', project.name, options)
    const namespace = this._app.config.driver.options.projectNamespace || 'flowforge'
    const stack = project.ProjectStack.properties

    const localPod = JSON.parse(JSON.stringify(podTemplate))
    localPod.metadata.name = project.name
    localPod.metadata.labels.name = project.name
    localPod.metadata.labels.app = project.id
    if (stack.container) {
        localPod.spec.containers[0].image = stack.container
    } else {
        localPod.spec.containers[0].image = `${this._options.registry}flowforge/node-red`
    }

    const baseURL = new URL(this._app.config.base_url)
    const projectURL = `${baseURL.protocol}//${project.name}.${this._options.domain}`

    const authTokens = await project.refreshAuthTokens()

    localPod.spec.containers[0].env.push({ name: 'FORGE_CLIENT_ID', value: authTokens.clientID })
    localPod.spec.containers[0].env.push({ name: 'FORGE_CLIENT_SECRET', value: authTokens.clientSecret })
    localPod.spec.containers[0].env.push({ name: 'FORGE_URL', value: this._app.config.api_url })
    localPod.spec.containers[0].env.push({ name: 'BASE_URL', value: projectURL })
    localPod.spec.containers[0].env.push({ name: 'FORGE_PROJECT_ID', value: project.id })
    localPod.spec.containers[0].env.push({ name: 'FORGE_PROJECT_TOKEN', value: authTokens.token })
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

    const localService = JSON.parse(JSON.stringify(serviceTemplate))
    localService.metadata.name = project.name
    localService.spec.selector.name = project.name

    const localIngress = JSON.parse(JSON.stringify(ingressTemplate))
    localIngress.metadata.name = project.name
    localIngress.spec.rules[0].host = project.name + '.' + this._options.domain
    localIngress.spec.rules[0].http.paths[0].backend.service.name = project.name

    if (process.env.FLOWFORGE_CLOUD_PROVIDER === 'aws' || this._app.config.driver.options.cloudProvider === 'aws') {
        localIngress.metadata.annotations = {
            'kubernetes.io/ingress.class': 'alb',
            'alb.ingress.kubernetes.io/scheme': 'internet-facing',
            'alb.ingress.kubernetes.io/target-type': 'ip',
            'alb.ingress.kubernetes.io/group.name': 'flowforge',
            'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}, {"HTTP":80}]'
        }
    }

    project.url = projectURL
    await project.save()

    const promises = []
    promises.push(this._k8sApi.createNamespacedPod(namespace, localPod).catch(err => {
        console.log(err)
        this._app.log.error(`[k8s] Project ${project.id} - error creating pod: ${err.toString()}`)
        // rethrow the error so the wrapper knows this hasn't worked
        throw err
    }))
    /* eslint node/handle-callback-err: "off" */ 
    promises.push(this._k8sApi.createNamespacedService(namespace, localService).catch(err => {
        // TODO: This will fail if the service already exists. Which it okay if
        // we're restarting a suspended project. As we don't know if we're restarting
        // or not, we don't know if this is fatal or not.

        // Once we can know if this is a restart or create, then we can decide
        // whether to throw this error or not. For now, this will silently
        // let it pass
        //
        // this._app.log.error(`[k8s] Project ${project.id} - error creating service: ${err.toString()}`)
        // throw err
    }))

    promises.push(this._k8sNetApi.createNamespacedIngress(namespace, localIngress).catch(err => {
        // TODO: This will fail if the service already exists. Which it okay if
        // we're restarting a suspended project. As we don't know if we're restarting
        // or not, we don't know if this is fatal or not.

        // Once we can know if this is a restart or create, then we can decide
        // whether to throw this error or not. For now, this will silently
        // let it pass
        //
        // this._app.log.error(`[k8s] Project ${project.id} - error creating ingress: ${err.toString()}`)
        // throw err
    }))

    return Promise.all(promises).then(async () => {
        this._app.log.debug(`[k8s] Container ${project.id} started`)
        project.state = 'running'
        await project.save()
        setTimeout(() => {
            // Give the container a few seconds to get the launcher process started
            this._projects[project.id].state = 'started'
            // TODO: how long should this be for a k8s setup?
        }, 3000)
    })
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

        // if (configFile) {
        //   kc.loadFromFile(configFile);
        // } else {
        // try and load defaults
        kc.loadFromDefault()
        // else need to log error
        // }

        // need to add code here to check for existing projects and restart if needed

        this._k8sApi = kc.makeApiClient(k8s.CoreV1Api)
        this._k8sAppApi = kc.makeApiClient(k8s.AppsV1Api)
        this._k8sNetApi = kc.makeApiClient(k8s.NetworkingV1Api)

        // Get a list of all projects - with the absolute minimum of fields returned
        const projects = await app.db.models.Project.findAll({
            attributes: [
                'id',
                'name',
                'state',
                'ProjectStackId'
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
            projects.forEach(async (project) => {
                try {
                    if (project.state === 'suspended') {
                        // Do not restart suspended projects
                        return
                    }
                    try {
                        await this._k8sApi.readNamespacedPodStatus(project.name, this._namespace)
                    } catch (err) {
                        this._app.log.debug(`[k8s] Project ${project.id} - recreating container`)
                        const fullProject = await this._app.db.models.Project.byId(project.id)
                        await createPod(fullProject)
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
        return createPod(project)
    },

    /**
     * Stop a Project
     * @param {Project} project - the project model instance
     */
    stop: async (project) => {
        // Stop the project, but don't remove all of its resources.
        this._projects[project.id].state = 'stopping'
        // For now, we just want to remove the pod
        await this._k8sApi.deleteNamespacedPod(project.name, this._namespace)
        this._projects[project.id].state = 'suspended'
        return new Promise(resolve => {
            const pollInterval = setInterval(async () => {
                try {
                    await this._k8sApi.readNamespacedPodStatus(project.name, this._namespace)
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
            await this._k8sNetApi.deleteNamespacedIngress(project.name, this._namespace)
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting ingress: ${err.toString()}`)
        }
        try {
            await this._k8sApi.deleteNamespacedService(project.name, this._namespace)
        } catch (err) {
            this._app.log.error(`[k8s] Project ${project.id} - error deleting service: ${err.toString()}`)
        }
        try {
            // A suspended project won't have a pod to delete - but try anyway
            // just in case state has got out of sync
            await this._k8sApi.deleteNamespacedPod(project.name, this._namespace)
        } catch (err) {
            if (project.state !== 'suspended') {
                // A suspended project is expected to error here - so only log
                // if the state is anything else
                this._app.log.error(`[k8s] Project ${project.id} - error deleting pod: ${err.toString()}`)
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
        if (this._projects[project.id].state === 'suspended') {
            // We should only poll the launcher if we think it is running.
            // Otherwise, return our cached state
            return {
                state: this._projects[project.id].state
            }
        }
        // this._app.log.debug('checking actual pod, not cache')
        try {
            const details = await this._k8sApi.readNamespacedPodStatus(project.name, this._namespace)
            // console.log(project.name, details.body)
            // this._app.log.debug(`details: ${details.body.status}`)

            if (details.body.status.phase === 'Running') {
                const infoURL = `http://${project.name}.${this._namespace}:2880/flowforge/info`
                try {
                    const info = JSON.parse((await got.get(infoURL)).body)
                    // this._app.log.debug(`info: ${JSON.stringify(info)}`)
                    this._projects[project.id].state = info.state
                    return info
                } catch (err) {
                    // TODO
                    this._app.log.debug(`err getting state from ${project.id}: ${err}`)
                    return
                }
            } else if (details.body.status.phase === 'Pending') {
                this._projects[project.id].state = 'starting'
                return {
                    id: project.id,
                    state: 'starting',
                    meta: details.body.status
                }
            }
        } catch (err) {
            // console.log(err)
            this._app.log.debug(`Failed to load pod status for ${project.id}`)
            return { error: err, state: 'unknown' }
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
        await got.post(`http://${project.name}.${this._namespace}:2880/flowforge/command`, {
            json: {
                cmd: 'start'
            }
        })
        return { status: 'okay' }
    },

    /**
     * Stops the flows
     * @param {Project} project - the project model instance
     * @return {forge.Status}
     */
    stopFlows: async (project) => {
        await got.post(`http://${project.name}.${this._namespace}:2880/flowforge/command`, {
            json: {
                cmd: 'stop'
            }
        })
        return Promise.resolve({ status: 'okay' })
    },

    /**
     * Get a Project's logs
     * @param {Project} project - the project model instance
     * @return {array} logs
     */
    logs: async (project) => {
        try {
            const result = await got.get(`http://${project.name}.${this._namespace}:2880/flowforge/logs`).json()
            return result
        } catch (err) {
            console.log(err)
            return ''
        }
    },

    /**
     * Restarts the flows
     * @param {Project} project - the project model instance
     * @return {forge.Status}
     */
    restartFlows: async (project) => {
        await got.post(`http://${project.name}.${this._namespace}:2880/flowforge/command`, {
            json: {
                cmd: 'restart'
            }
        })
        return { state: 'okay' }
    },

    /**
     * Shutdown Driver
     */
    shutdown: async () => {
        clearTimeout(this._initialCheckTimeout)
    }
}
