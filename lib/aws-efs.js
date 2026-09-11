const { EFSClient, DescribeFileSystemsCommand, DescribeAccessPointsCommand, ThrottlingException } = require('@aws-sdk/client-efs')
const retry = require('async-retry')

let client

let inflight
let lastTime = 0
const cacheTime = 30 * 1000 // 30 seconds

async function lookupStorageClass (tagName) {
    // console.log(`Looking for ${tagName}`)

    let fileSystems
    if (inflight && (Date.now() - lastTime) < cacheTime) {
        // Share the in-flight lookup with any caller that arrives while it is still
        // running. A burst of instance creations would otherwise each make their own
        // set of AWS calls, which is what triggers the ThrottlingException in #401
        fileSystems = await inflight
    } else {
        // Start the cache window now rather than on completion, so callers arriving
        // during the lookup share it instead of kicking off a second one
        lastTime = Date.now()
        inflight = doLookupStorageClass(tagName)

        try {
            fileSystems = await inflight
        } catch (err) {
            // Don't cache a failure - let the next caller try again
            inflight = undefined
            lastTime = 0
            throw err
        }
    }

    if (fileSystems.length === 0) {
        return undefined
    }

    // Account for the access point this caller is about to create. Without this a
    // burst of instances served from one cached read would all land on whichever
    // filesystem was least loaded when the counts were taken, rather than being
    // spread across them. The count is an estimate - it assumes the caller goes on
    // to create the access point - and is corrected by the next refresh
    const selected = fileSystems[0]
    selected.apCount++
    fileSystems.sort((a, b) => a.apCount - b.apCount)

    return selected.storageClass
}

async function doLookupStorageClass (tagName) {
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

    return fileSystems
}

module.exports = {
    lookupStorageClass
}
