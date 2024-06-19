const { EFSClient, DescribeFileSystemsCommand, DescribeAccessPointsCommand } = require("@aws-sdk/client-efs")

const client = new EFSClient(config)

async function lookupStorageClass (tag) {

    const fsCommand = new DescribeFileSystemsCommand()
    const fsList = await client.send(fsCommand)
    console.log(fsList)

    for (let i = 0; i< fsList.FileSystems.length; i++) {
        let found = false
        let storageClass = ''
        fsList.FileSystems[i].Tags.forEach(tag => {
            if (tag.Key === tag) {
                found = true
            } 
            if (tag.Key === 'storage-class-name') {
                storageClass = tag.Value
            }
        })
        if (found) {
            const apParams = {
                FileSystemId: fsList.FileSystems[i].FileSystemId
            }
            // console.log(apParams)
            const apListCommand = new DescribeAccessPointsCommand(apParams)
            const apList = await client.send(apListCommand)
            fileSystems[fsList.FileSystems[i].FileSystemId] = {
                apCount: apList.AccessPoints.length,
                storageClass
            }
        }
        
    }
    fileSystems.sort((a,b) => a.apCount - b.apCount)

    return fileSystems[0].storageClass

    // console.log(JSON.stringify(fileSystems, null, 2))
}


module.exports = {
    lookupStorageClass
}