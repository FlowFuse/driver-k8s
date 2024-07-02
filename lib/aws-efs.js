const { EFSClient, DescribeFileSystemsCommand, DescribeAccessPointsCommand } = require("@aws-sdk/client-efs")

let client

async function lookupStorageClass (tagName) {

    // console.log(`Looking for ${tagName}`)

    if (!client) {
        client = new EFSClient()
    }

    const fsCommand = new DescribeFileSystemsCommand()
    const fsList = await client.send(fsCommand)
    // console.log(JSON.stringify(fsList, null, 2))

    const fileSystems = []

    for (let i = 0; i<fsList.FileSystems.length; i++) {
        let found = false
        let storageClass = ''
        for (let j = 0; j<fsList.FileSystems[i].Tags.length; j++) {
            const tag = fsList.FileSystems[i].Tags[j]
            if (tag.Key === tagName) {
                found = true
            } 
            if (tag.Key === 'storage-class-name') {
                storageClass = tag.Value
            }
        }
        if (found) {
            // console.log(storageClass)
            const apParams = {
                FileSystemId: fsList.FileSystems[i].FileSystemId
            }
            // console.log(apParams)
            const apListCommand = new DescribeAccessPointsCommand(apParams)
            const apList = await client.send(apListCommand)
            // fileSystems[fsList.FileSystems[i].FileSystemId] 
            fileSystems.push({
                apCount: apList.AccessPoints.length,
                storageClass
            })
        } 
    }
    fileSystems.sort((a,b) => a.apCount - b.apCount)

    return fileSystems[0]?.storageClass
}


module.exports = {
    lookupStorageClass
}