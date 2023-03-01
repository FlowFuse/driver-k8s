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
```

- `registry` is the Docker Registry to load Stack Containers from
- `projectNamespace` the namespace Project pods should run in
- `projectSelector` a list of labels that should be used to select which nodes Project Pods
should run on
- `cloudProvider` can be left unset for none `aws` deployments. This triggers the adding of
AWS EKS specific annotation for ALB Ingress.
- `privateCA` name of ConfigMap holding PEM CA Cert Bundle (file name `certs.pem`) Optional

Expects to pick up K8s credentials from the environment