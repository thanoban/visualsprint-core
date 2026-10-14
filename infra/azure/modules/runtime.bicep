param location string
param environmentId string
param name string
param vaultName string
param image string
param registryName string
param registryResourceGroup string
param registrySubscriptionId string
@allowed(['api', 'worker', 'job'])
param mode string
param command array
param env array
param secretBindings array
param minReplicas int = 1
param maxReplicas int = 3
param cpu string = '0.5'
param memory string = '1Gi'
param port int = 8080
param healthPath string = '/health'
param cron string = ''

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: '${name}-identity', location: location }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }
resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for binding in secretBindings: { parent: vault, name: binding.secretName }]
resource readSecret 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (binding, i) in secretBindings: {
  name: guid(secrets[i].id, identity.id, 'secret-reader')
  scope: secrets[i]
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') }
}]
module registry './registry-access.bicep' = {
  name: '${name}-image-pull'
  scope: resourceGroup(registrySubscriptionId, registryResourceGroup)
  params: { registryName: registryName, principalId: identity.properties.principalId }
}
var secretRefs = [for binding in secretBindings: { name: binding.ref, keyVaultUrl: 'https://${vaultName}${environment().suffixes.keyvaultDns}/secrets/${binding.secretName}/${binding.version}', identity: identity.id }]
var secretEnv = [for binding in secretBindings: { name: binding.env, secretRef: binding.ref }]
var containerEnv = concat(env, secretEnv, [{ name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }])
var userIdentity = { '${identity.id}': {} }
resource app 'Microsoft.App/containerApps@2025-07-01' = if (mode != 'job') {
  name: name
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: userIdentity }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      // external applies within this private environment, not to the public Internet.
      ingress: mode == 'api' ? { external: true, targetPort: port, transport: 'auto', allowInsecure: false, traffic: [{ latestRevision: true, weight: 100 }] } : null
      secrets: secretRefs
      registries: [{ server: '${registryName}.azurecr.io', identity: identity.id }]
    }
    template: {
      containers: [{ name: 'service', image: image, command: command, env: containerEnv, resources: { cpu: json(cpu), memory: memory }, probes: mode == 'api' ? [
        { type: 'Startup', tcpSocket: { port: port }, initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 30 }
        { type: 'Readiness', httpGet: { path: healthPath, port: port, scheme: 'HTTP' }, periodSeconds: 5, failureThreshold: 3 }
        { type: 'Liveness', httpGet: { path: healthPath, port: port, scheme: 'HTTP' }, periodSeconds: 30, failureThreshold: 3 }
      ] : [] }]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas, rules: mode == 'api' ? [{ name: 'http', http: { metadata: { concurrentRequests: '20' } } }] : [] }
    }
  }
  dependsOn: [registry, readSecret]
}
resource job 'Microsoft.App/jobs@2025-07-01' = if (mode == 'job') {
  name: name
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: userIdentity }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: empty(cron) ? 'Manual' : 'Schedule'
      replicaTimeout: 1800
      // External uncertain operations and migrations must never be automatically retried by the platform.
      replicaRetryLimit: 0
      manualTriggerConfig: empty(cron) ? { parallelism: 1, replicaCompletionCount: 1 } : null
      scheduleTriggerConfig: empty(cron) ? null : { cronExpression: cron, parallelism: 1, replicaCompletionCount: 1 }
      secrets: secretRefs
      registries: [{ server: '${registryName}.azurecr.io', identity: identity.id }]
    }
    template: { containers: [{ name: 'service', image: image, command: command, env: containerEnv, resources: { cpu: json(cpu), memory: memory } }] }
  }
  dependsOn: [registry, readSecret]
}
output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
output identityId string = identity.id
output resourceId string = mode == 'job' ? job!.id : app!.id
