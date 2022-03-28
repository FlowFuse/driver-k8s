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
```

Expects to pick up K8s credentials from the environment