# FlowForge Docker Container Driver

FlowForge driver to create projects as docker containers

## Configuration

 - `CONTAINER_DRIVER=kubernetes` 
 - `KUBE_REGISTRY` - Where to find FlowForge containers 
 - `BASE_URL` - Where to find Forge APIs
 - `DOMAIN` - What to append to the end of the project name

Expects to pick up K8s credentials from the environment