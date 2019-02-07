const storage = require('azure-storage');
const Stream = require('stream');
const request = require('request');
const AdmZip = require('adm-zip');
const mime = require('mime-types');
const url = require('url');


const ClientFactory = require('./ClientFactory');

/**
 *
 *
 */
module.exports = class ResourceFactory {

    constructor(clientId, clientSecret, tenantId, subscriptionId, resourceGroupName){
        this.resourceStack = [];
        this.factory = new ClientFactory(clientId, clientSecret, tenantId, subscriptionId);
        this.resourceGroupName = resourceGroupName;
    }


    async init(){
        await this.factory.init();
    }

    async withStack(object){
        this.resourceStack.push(object);
        return object;
    }

    async rollBack(){
        console.log("initiated rollback");
        for (let i = this.resourceStack.length -1 ; i >= 0; i--) {
            await this.deleteResourcesById(this.resourceStack.pop());
        }

        // await this.resourceStack.slice().reverse().forEach( async (resource) =>
        //    await this.deleteResourcesById(resource));
    }

    async createResourceGroup(resourceGroupName = this.resourceGroupName, location = 'westus', tags = {}) {

        let groupParameters = {
            location: location,
            tags: tags
        };

        let client = await this.factory.getResource("ResourceManagementClient");
        let result = await client.resourceGroups.createOrUpdate(resourceGroupName, groupParameters);
        return this.withStack(result);
    }


    async createHostingPlan(resourceGroupName = this.resourceGroupName, location = 'westus', tags = {}, planSkuName = 'Y1', planName = 'WestUSPlan') {
        //https://azure.microsoft.com/en-us/pricing/details/app-service/windows/
        let info = {
            location: location,
            tags: tags,
            sku: {
                name: planSkuName,
                capacity: 0
            }
        };

        let client = await this.factory.getResource("WebAppManagementClient");
        let result = await client.appServicePlans.createOrUpdate(resourceGroupName, planName, info);
        return this.withStack(result);
    }


    async createStorageAccount(storageAccountName, tags = {}, location = 'westus', skuName = 'Standard_LRS', resourceGroupName = this.resourceGroupName) {
        let options = {
            tags: tags,
            sku: {
                name: skuName
            },
            kind: "StorageV2",
            location: location,
            accessTier: "Hot"
        };
        let client = await this.factory.getResource("StorageManagementClient");
        let result = await client.storageAccounts.create(resourceGroupName, storageAccountName, options);
        this.storageAccountName = storageAccountName;
        return this.withStack(result);
    }


    async createBlobContainer(storageName, resourceGroupName = this.resourceGroupName) {
        let client = await this.factory.getResource("StorageManagementClient");
        return await client.blobContainers.create(resourceGroupName, storageName, "$web");
    }


    async setBlobServicePropertiesForWebsite(accountKey, storageName = this.storageAccountName) {
        let serviceProperties = {
            StaticWebsite: {
                Enabled: true,
                IndexDocument: "index.html",
                ErrorDocument404Path: "error/404.html"
            }
        };

        let blobStorage = storage.createBlobService(storageName,accountKey);
        return new Promise(function(resolve, reject) {
            blobStorage.setServiceProperties(serviceProperties, function(err, resp, body) {
                if (err) {
                    reject(err);
                } else {
                    resolve(resp);
                }
            })
        });
    }


    async listStorageAccountKeys(storageName = this.storageAccountName, resourceGroupName = this.resourceGroupName) {
        let client = await this.factory.getResource("StorageManagementClient");
        return await client.storageAccounts.listKeys(resourceGroupName, storageName, null);
    }


    async createWebApp(appName, envelope, resourceGroupName = this.resourceGroupName) {
        let client = await this.factory.getResource("WebAppManagementClient");
        let result = await client.webApps.createOrUpdateWithHttpOperationResponse(resourceGroupName, appName, envelope);
        return this.withStack(result);
    }


    async createFunctionApp( appName, storageAccountKey, tags = {}, storageAccountName = this.storageAccountName, resourceGroupName = this.resourceGroupName, location = 'westus') {
        let envelope = {
            tags: tags,
            location: location,
            kind: "functionApp",
            serverFarmId: "WestUSPlan",
            properties: {},
            siteConfig: {
                appSettings: [
                    {
                        "name": "FUNCTIONS_WORKER_RUNTIME",
                        "value": "node"
                    },

                    {
                        "name": "FUNCTIONS_EXTENSION_VERSION",
                        "value": "~2"
                    },

                    {
                        "name": "WEBSITE_NODE_DEFAULT_VERSION",
                        "value": "8.11.1"
                    },

                    {
                        "name": "AzureWebJobsStorage",
                        "value": `DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageAccountKey}`
                    },

                    {
                        "name": "WEBSITE_CONTENTAZUREFILECONNECTIONSTRING",
                        "value": `DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageAccountKey}`
                    },
                    {
                        "name": "WEBSITE_CONTENTSHARE",
                        "value": storageAccountName
                    },
                ]
            }
        }
        return await this.createWebApp(appName, envelope, resourceGroupName = this.resourceGroupName );
    }


    async listResourcesByTag(tagName) {
        let client = await this.factory.getResource("ResourceManagementClient");
        let resourcesByTags = await client.resources.list({filter: `tagName eq '${tagName}'`});
        return resourcesByTags;
    }



    async deleteResourcesByTag(tagName) {
        let resources = await this.listResourcesByTag(tagName);
        resources.forEach(async function (resource) {
            await this.deleteResourcesById(resource);
        });
    }


    async deleteResourcesById(resource) {
        let client = await this.factory.getResource("ResourceManagementClient");
        console.log("deleting " + resource.id);
        let apiVersion = await this.getLatestApiVersionForResource(resource);

        return await client.resources.deleteById(resource.id, apiVersion);
    }


    async getLatestApiVersionForResource(resource) {
        let client = await this.factory.getResource("ResourceManagementClient");
        let providerNamespace = resource.type.split('/')[0];
        let providerType = resource.type.split('/')[1];
        let response = await client.providers.get(providerNamespace);
        let apiVersion = undefined;
        await response['resourceTypes'].forEach(async function (resource) {

            if (resource.resourceType.toLowerCase() === providerType.toLowerCase()) {
                apiVersion = resource.apiVersions[0];
            }
        });
        return apiVersion;
    }


    async createOrUpdateApiGatewayWithSwaggerJson(serviceName, apiId, swagger, basePath = "api", resourceGroupName = this.resourceGroupName) {
        let parameters = {
            "contentFormat": "swagger-json",
            "contentValue": JSON.stringify(swagger),
            "path": basePath
        }
        let client = await this.factory.getResource("ApiManagementClient");
        let result = await client.api.createOrUpdateWithHttpOperationResponse(resourceGroupName, serviceName, apiId, parameters, null);
        return result;
    }


    async deleteApi(serviceName, apiId, resourceGroupName = this.resourceGroupName) {
        let client = await this.factory.getResource("ApiManagementClient");
        let result = await client.api.deleteMethodWithHttpOperationResponse(resourceGroupName, serviceName, apiId, "*", null);
        return result;
    }


    async addApiToProduct(serviceName, productId, apiId, resourceGroupName = this.resourceGroupName) {
        let client = await this.factory.getResource("ApiManagementClient");
        let result = await client.productApi.createOrUpdate(resourceGroupName, serviceName, productId, apiId, null);
        return result;
    }


    async createCdnProfile(tags = {}, storageName = this.storageAccountName, resourceGroupName = this.resourceGroupName, location = "West US", skuName = "Standard_Akamai") {
        let standardCreateParameters = {
            location: location,
            tags: tags,
            sku: {
                name: skuName
            }
        };
        let client = await this.factory.getResource("CdnManagementClient");
        return client.profiles.create(resourceGroupName, storageName, standardCreateParameters)
    }


    async createCdnEndpoint(tags = {}, hostname = this.storageAccountName,  storageName = this.storageAccountName, resourceGroupName = this.resourceGroupName, location = "West US") {
        let path = url.parse(hostname, true);
        console.log(path.path);
        let endpointProperties = {
            location: 'West US',
            tags: tags,
            origins: [{
                name: 'newname',
                hostName: path.host
            }]
        }

        let client = await this.factory.getResource("CdnManagementClient");
        return client.endpoints.create(resourceGroupName, storageName, storageName, endpointProperties);
    }


    async uploadFilesToStorageFromZipBase64(accountKey, b64string, storageName = this.storageAccountName){
        let blobStorageService = storage.createBlobService(storageName,accountKey);
        let buffer = Buffer.from(b64string, 'base64');
        let zip = new AdmZip(buffer);
        let zipEntries = zip.getEntries();
        let promiseArray = [];

        for (let i = 0; i < zipEntries.length; i++) {
            console.log(zipEntries[i].entryName);
            let decompressedData = zip.readFile(zipEntries[i]);
            let stream = new Stream.PassThrough();
            stream.end(decompressedData);
            promiseArray.push(new Promise(function(resolve, reject){
                blobStorageService.createBlockBlobFromStream("$web", zipEntries[i].entryName, stream, buffer.length, {contentSettings: {contentType: mime.lookup(zipEntries[i].entryName)}} ,function (error, result, response) {
                    if (error) {
                        console.error(error);
                        reject("Couldn't upload stream");

                    } else {
                        console.log('Stream uploaded successfully: ' + i + " " + zipEntries[i].entryName + "    " +  mime.lookup(zipEntries[i].entryName));
                        resolve(result);
                    }
                });
            }));
        }
        return await Promise.all(promiseArray).then(() => { console.log('resolved!'); })
            .catch(() => { console.log('failed!') });
    }


    async uploadZipToKudu(appName, b64string, resourceGroup = this.resourceGroupName) {
        let buffer = Buffer.from(b64string, 'base64');
        let stream = new Stream.PassThrough();
        stream.end(buffer);

        let client = await this.factory.getResource("WebAppManagementClient");
        let publishingCredentials = await client.webApps.listPublishingCredentials(resourceGroup, appName, null);
        console.log("Trying to upload a file");
        let config = {
            headers: {
                Accept: '*/*'
            },
            auth: {
                username: publishingCredentials.publishingUserName,
                password: publishingCredentials.publishingPassword
            },
            encoding: null,
            body: stream
        };

        return new Promise(function(resolve, reject) {
            request({
                url: `https://${appName}.scm.azurewebsites.net/api/zipdeploy`,
                method: 'PUT',
                body: stream,
                encoding: null,
                auth: {
                    username: publishingCredentials.publishingUserName,
                    password: publishingCredentials.publishingPassword
                },
                headers: {
                    Accept: '*/*'
                }
            }, function(err, resp, body) {
                if (err) {
                    reject(err);
                } else {
                    resolve(resp);
                }
            })
        });
    }
}
