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
                        cpu: "100m",
                        memory: "128Mi"
                    },
                    limits: {
                        cpu: "125m",
                        memory: "192Mi"
                    }
                },
                name: 'node-red',
                // image: "docker-pi.local:5000/bronze-node-red",
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
            role: "projects"
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
        namespace: 'flowforge',
        annotations: {
            'kubernetes.io/ingress.class': 'alb',
            'alb.ingress.kubernetes.io/scheme': 'internet-facing',
            'alb.ingress.kubernetes.io/target-type': 'ip',
            'alb.ingress.kubernetes.io/group.name': 'flowforge',
            'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}, {"HTTP":80}]'
        }
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

module.exports = {
    /**
   * Initialises this driver
   * @param {string} app - the Vue application
   * @param {object} options - A set of configuration options for the driver
   * @return {forge.containers.ProjectArguments}
   */
    init: async (app, options) => {
        this._app = app
        this._options = options
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


        const projects = await this._app.db.models.Project.findAll()
        projects.forEach(async (project)=>{
            if (project.state === 'running') {
                try {
                    await this._k8sApi.readNamespacedPodStatus(project.name, 'flowforge')
                } catch (err) {
                    console.log(err.response.body)
                    this.create(project, {env: JSON.parse(project.getSetting('environmentVariables'))})
                }
            }
        })


        // need to work out what we can expose for K8s
        return {
            stack: {
                properties: {
                    cpu: {
                        label: 'CPU Cores (%)',
                        validate: '^[1-9][0-9]|100$',
                        invalidMessage: 'Invalid value - must be a number between 1 and 100'
                    },
                    memory: {
                        label: 'Memory (MB)',
                        validate: '^[1-9]\\d*$',
                        invalidMessage: 'Invalid value - must be a number'
                    },
                    container: {
                        label: 'Container Location',
                        // taken from https://stackoverflow.com/a/62964157
                        validate: '^(([a-z0-9]|[a-z0-9][a-z0-9\\-]*[a-z0-9])\\.)*([a-z0-9]|[a-z0-9][a-z0-9\\-]*[a-z0-9])(:[0-9]+\\/)?(?:[0-9a-z-]+[/@])(?:([0-9a-z-]+))[/@]?(?:([0-9a-z-]+))?(?::[a-z0-9\\.-]+)?$',
                        invalidMessage: 'Invalid value - must be a Docker image'
                    }
                }
            }
        }
    },
    /**
   * Create a new Project
   * @param {string} id - id for the project
   * @param {forge.containers.Options} options - options for the project
   * @return {forge.containers.Project}
   */
    create: async (project, options) => {
        console.log('creating ', project.name, options)
        const stack = project.ProjectStack.properties
        const localPod = JSON.parse(JSON.stringify(podTemplate))
        localPod.metadata.name = project.name
        localPod.metadata.labels.name = project.name
        localPod.metadata.labels.app = project.id
        // localPod.spec.containers[0].image = `${this._options.registry}flowforge/node-red` // this._options.containers[project.type];
        localPod.spec.containers[0].image = stack.container
        if (options.env) {
            Object.keys(options.env).forEach(k => {
                if (k) {
                    localPod.spec.containers[0].env.push({
                        name: k,
                        value: options.env[k]
                    })
                }
            })
            project.updateSetting('environmentVariables', JSON.stringify(options.env))
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

        localPod.spec.containers[0].resources.request.memory = `${stack.memory}Mi`
        localPod.spec.containers[0].resources.limit.memory = `${stack.memory}Mi`
        localPod.spec.containers[0].resources.request.cpu = `${stack.cpu * 10}m`
        localPod.spec.containers[0].resources.limit.cpu = `${stack.cpu * 10}m`

        const localService = JSON.parse(JSON.stringify(serviceTemplate))
        localService.metadata.name = project.name
        localService.spec.selector.name = project.name

        const localIngress = JSON.parse(JSON.stringify(ingressTemplate))
        localIngress.metadata.name = project.name
        localIngress.spec.rules[0].host = project.name + '.' + this._options.domain
        localIngress.spec.rules[0].http.paths[0].backend.service.name = project.name

        try {
            await this._k8sApi.createNamespacedPod('flowforge', localPod)
            await this._k8sApi.createNamespacedService('flowforge', localService)
            await this._k8sNetApi.createNamespacedIngress('flowforge', localIngress)
        } catch (err) {
            console.log(err)
            return { error: err }
        }

        project.url = projectURL
        await project.save()

        return {
            id: project.id,
            status: 'okay',
            url: projectURL,
            meta: {}
        }
    },
    /**
   * Removes a Project
   * @param {string} id - id of project to remove
   * @return {Object}
   */
    remove: async (project) => {
    // let project = await this._app.db.models.Project.byId(id)

        const promises = []

        promises.push(this._k8sNetApi.deleteNamespacedIngress(project.name, 'flowforge'))
        promises.push(this._k8sApi.deleteNamespacedService(project.name, 'flowforge'))
        promises.push(this._k8sApi.deleteNamespacedPod(project.name, 'flowforge'))

        try {
            await Promise.all(promises)

            return {
                status: 'okay'
            }
        } catch (err) {
            return {
                error: err
            }
        }
    },
    /**
   * Retrieves details of a project's container
   * @param {string} id - id of project to query
   * @return {Object}
   */
    details: async (project) => {
        try {
            const details = await this._k8sApi.readNamespacedPodStatus(project.name, 'flowforge')
            // console.log(project.name, details.body)
            // console.log(details.body.status)

            if (details.body.status.phase === 'Running') {
                const infoURL = 'http://' + project.name + '.flowforge:2880/flowforge/info'
                try {
                    const info = JSON.parse((await got.get(infoURL)).body)
                    return info
                } catch (err) {
                    // TODO
                    return
                }
            } else if (details.body.status.phase === 'Pending') {
                return {
                    id: project.id,
                    state: 'starting',
                    meta: details.body.status
                }
            }
        } catch (err) {
            console.log(err)
            return { error: err }
        }

        // let infoURL = "http://" + project.name + ".flowforge:2880/flowforge/info"
        // try {
        //   let info = JSON.parse((await got.get(infoURL)).body)
        //   return info
        // } catch (err) {
        //   //TODO
        //   return
        // }
    },
    /**
   * Returns the settings for the project
  */
    settings: async (project) => {
    // let project = await this._app.db.models.DockerProject.byId(id)
        // const projectSettings = await project.getAllSettings()
        // let options = JSON.parse(project.options)
        const settings = {}
        settings.projectID = project.id
        settings.port = 1880
        settings.rootDir = '/'
        settings.userDir = 'data'

        return settings
    },
    /**
   * Lists all containers
   * @param {string} filter - rules to filter the containers
   * @return {Object}
   */
    list: async (filter) => {
        this._k8sApi.listNamespacedPod('flowforge', undefined, undefined, undefined, undefined, 'nodered=true')
            .then((pods) => {
                // Turn this into a standard form
            })
    },
    /**
   * Starts a Project's container
   * @param {string} id - id of project to start
   * @return {forge.Status}
   */
    start: async (project) => {
    // there is no concept of start/stop in Kubernetes
        await got.post('http://' + project.name + '.flowforge:2880/flowforge/command', {
            json: {
                cmd: 'start'
            }
        })

        project.state = 'starting'
        project.save()

        return { status: 'okey' }
    },
    /**
   * Stops a Proejct's container
   * @param {string} id - id of project to stop
   * @return {forge.Status}
   */
    stop: async (project) => {
    // there is no concept of start/stop in Kubernetes
        await got.post('http://' + project.name + '.flowforge:2880/flowforge/command', {
            json: {
                cmd: 'stop'
            }
        })
        project.state = 'stopped'
        project.save()
        return Promise.resolve({ status: 'okay' })
    },
    logs: async (project) => {
        try {
            const result = await got.get('http://' + project.name + '.flowforge:2880/flowforge/logs').json()
            return result
        } catch (err) {
            console.log(err)
            return ''
        }
    },
    /**
   * Restarts a Project's container
   * @param {string} id - id of project to restart
   * @return {forge.Status}
   */
    restart: async (project) => {
        await got.post('http://' + project.name + '.flowforge:2880/flowforge/command', {
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

    }
}
