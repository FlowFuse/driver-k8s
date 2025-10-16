# FlowForge Docker Container Driver

FlowForge driver to create projects as docker containers

## Configuration

In the `flowforge.yml` file

```yaml
...
driver:
  type: kubernetes
  options:
    registry: containers.flowforge.com
    projectSelector:
      role: projects
    projectNamespace: flowforge
    projectLabels:
      environment: production
      team: alpha
    cloudProvider: aws
    privateCA: ff-ca-certs
    certManagerIssuer: lets-encrypt
    k8sDelay: 1000
    k8sRetries: 10
    logPassthrough: true
    customHostname:
      enabled: true
      cnameTarget: custom-loadbalancer.example.com
      certManagerIssuer: lets-encrypt
      ingressClass: custom-nginx
    storage:
      enabled: true
      storageClass: nfs-storage
      size: 5Gi
    podSecurityContext:
      runAsUser: 1000
      runAsGroup: 1000
      fsGroup: 1000
```

- `registry` is the Docker Registry to load Stack Containers from
- `projectNamespace` the namespace Project pods should run in
- `projectSelector` a list of labels that should be used to select which nodes Project Pods
should run on
- `projectLabels` a list of custom labels that should be applied to all resources created for Projects (Pods, Services, Ingresses, PVCs)
- `projectProbes` optional configuration for liveness, readiness and startup probes for project containers
- `projectProbes.livenessProbe` custom liveness probe configuration (default not set)
- `projectProbes.readinessProbe` custom readiness probe configuration (default not set)
- `projectProbes.startupProbe` custom startup probe configuration (default not set)
- `cloudProvider` normally not set, but can be `aws` This triggers the adding of
AWS EKS specific annotation for ALB Ingress. or `openshift` to allow running on OpenShift (Enterprise license only)
- `privateCA` name of ConfigMap holding PEM CA Cert Bundle (file name `certs.pem`) Optional
- `certManagerIssuer` name of the ClusterIssuer to use to create HTTPS certs for instances (default not set)
- `k8sRetries` how many times to retry actions against the K8s API
- `k8sDelay` how long to wait (in ms) between retries to the K8s API
- `logPassthrough` Have Node-RED logs printed in JSON format to container stdout (default false)
- `customHostname` Settings linked to allowing instances to have a second hostname
- `customHostname.enabled` (default false)
- `customHostname.cnameTarget` The hostname users should configure their DNS entries to point at. Required. (default not set)
- `customHostname.certManagerIssuer` Name of the Cluster issuer to use to create HTTPS certs for the custom hostname (default not set)
- `customHostname.ingressClass` Name of the IngressClass to use to expose the custom hostname (default not set)
- `storage.enabled` Mounts a persistent volume on `/data/storage` (default false)
- `storage.storageClass` Name of StorageClass to use to allocate the volume (default not set)
- `storage.storageClassEFSTag` Used instead of `storage.storageClass` when needing to shard across multiple EFS file systems (default not set)
- `storage.size` Size of the volume to request (default not set)
- `podSecurityContext` Settings linked to the [security context of the pod](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- `service.type` Type of service to create for the editor (allowed `ClusterIP` or `NodePort`, default `ClusterIP`)

Expects to pick up K8s credentials from the environment

### Configuration via environment variables

Next variables are read from flowforge process environment in runtime:

* `INGRESS_CLASS_NAME` - `Ingress` class name for editor instances
* `INGRESS_ANNOTATIONS` - `Ingress` annotations for editor instances as JSON-encoded object
* `DEPLOYMENT_TOLERATIONS` - Editor `Deployment` tolerations as JSON-encoded object
* `EDITOR_SERVICE_ACCOUNT` - Editor service account. 
