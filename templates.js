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
                        },
                        startupProbe: {
                            httpGet: {
                                path: '/flowforge/ready',
                                port: 'management'
                            },
                            initialDelaySeconds: 5,
                            periodSeconds: 2,
                            successThreshold: 1,
                            failureThreshold: 450
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

const persistentVolumeClaimTemplate = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {

    },
    spec: {
        accessModes: [
            'ReadWriteMany' // picked for HA mode
        ],
        resources: {
            requests: {
            }
        }
    }
}

const mqttSchemaAgentPodTemplate = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {

    },
    spec: {
        containers: [
            {
                name: 'mqtt-schema-agent',
                // image: 'flowfuse/mqtt-schema-agent',
                imagePullPolicy: 'Always',
                securityContext: {
                    allowPrivilegeEscalation: false
                },
                env: [
                    { name: 'TZ', value: 'Europe/London' }
                ],
                ports: [
                    { name: 'web', containerPort: 3500, protocol: 'TCP' }
                ],
                resources: {
                    requests: {
                        // 10th of a core
                        cpu: '100m',
                        memory: '128Mi'
                    },
                    limits: {
                        cpu: '100m',
                        memory: '128Mi'
                    }
                }
            }
        ]
    },
    enableServiceLinks: false
}

const mqttSchemaAgentServiceTemplate = {
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
            { name: 'web', port: 3500, protocol: 'TCP' }
        ]
    }
}

module.exports = {
    deploymentTemplate,
    serviceTemplate,
    ingressTemplate,
    customIngressTemplate,
    persistentVolumeClaimTemplate,
    mqttSchemaAgentPodTemplate,
    mqttSchemaAgentServiceTemplate
}
