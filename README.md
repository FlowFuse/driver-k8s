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
    cloudProvider: aws
    privateCA: ff-ca-certs
    certManagerIssuer: lets-encrypt
    k8sDelay: 1000
    k8sRetries: 10
    logPassthrough: true
```

- `registry` is the Docker Registry to load Stack Containers from
- `projectNamespace` the namespace Project pods should run in
- `projectSelector` a list of labels that should be used to select which nodes Project Pods
should run on
- `cloudProvider` normally not set, but can be `aws` This triggers the adding of
AWS EKS specific annotation for ALB Ingress. or `openshift` to allow running on OpenShift (Enterprise license only)
- `privateCA` name of ConfigMap holding PEM CA Cert Bundle (file name `certs.pem`) Optional
- `certManagerIssuer` name of the ClusterIssuer to use to create HTTPS certs for instances (default not set)
- `k8sRetries` how many times to retry actions against the K8s API
- `k8sDelay` how long to wait (in ms) between retries to the K8s API
- `logPassthrough` Have Node-RED logs printed in JSON format to container stdout (default false)

Expects to pick up K8s credentials from the environment

### Configuration via environment variables

Next variables are read from flowforge process environment in runtime:

* `INGRESS_CLASS_NAME` - `Ingress` class name for editor instances
* `INGRESS_ANNOTATIONS` - `Ingress` annotations for editor instances as JSON-encoded object
* `DEPLOYMENT_TOLERATIONS` - Editor `Deployment` tolerations as JSON-encoded object
* `EDITOR_SERVICE_ACCOUNT` - Editor service account. 
