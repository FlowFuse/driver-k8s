const { EFSClient, DescribeFileSystemsCommand, DescribeAccessPointsCommand, ThrottlingException } = require('@aws-sdk/client-efs')
const retry = require('async-retry')

let client

let lastClass
let lastTime = 0
const cacheTime = 30 * 1000 // 30 seconds

async function lookupStorageClass (tagName) {
    // console.log(`Looking for ${tagName}`)

    if (lastClass && lastTime && (Date.now() - lastTime) < cacheTime) {
        return lastClass
    }

    if (!client) {
        client = new EFSClient()
    }

    const fsCommand = new DescribeFileSystemsCommand()
    const fsList = await retry(async (bail) => {
        try {
            const list = await client.send(fsCommand)
            return list
        } catch (err) {
            if (err instanceof ThrottlingException) {
                throw err // retry after delay
            } else {
                return bail(err) // not Throttling, time to fail
            }
        }
    },
    {
        retries: 5,
        minTimeout: 500
    })
    // console.log(JSON.stringify(fsList, null, 2))

    const fileSystems = []

    for (let i = 0; i < fsList.FileSystems.length; i++) {
        let found = false
        let storageClass = ''
        for (let j = 0; j < fsList.FileSystems[i].Tags.length; j++) {
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
                FileSystemId: fsList.FileSystems[i].FileSystemId,
                MaxResults: 9999 // max access points per filesystem is now 10,000
            }
            // console.log(apParams)
            const apListCommand = new DescribeAccessPointsCommand(apParams)
            const apList = await retry(async (bail) => {
                try {
                    const list = await client.send(apListCommand)
                    return list
                } catch (err) {
                    if (err instanceof ThrottlingException) {
                        throw err // retry after delay
                    } else {
                        return bail(err) // not Throttling, time to fail
                    }
                }
            }, {
                retries: 5,
                minTimeout: 500
            })
            // fileSystems[fsList.FileSystems[i].FileSystemId]
            fileSystems.push({
                apCount: apList.AccessPoints.length,
                storageClass
            })
        }
    }
    fileSystems.sort((a, b) => a.apCount - b.apCount)

    lastClass = fileSystems[0]?.storageClass
    lastTime = Date.now()

    return fileSystems[0]?.storageClass
}

module.exports = {
    lookupStorageClass
}
