param namespaceName string
param topicName string
param principalId string
param receiver bool = false
resource bus 'Microsoft.ServiceBus/namespaces@2024-01-01' existing = { name: namespaceName }
resource topic 'Microsoft.ServiceBus/namespaces/topics@2024-01-01' existing = { parent: bus, name: topicName }
resource subscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2024-01-01' existing = { parent: topic, name: 'notification' }
resource sender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!receiver) {
  name: guid(topic.id, principalId, 'sender')
  scope: topic
  properties: { principalId: principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39') }
}
resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (receiver) {
  name: guid(subscription.id, principalId, 'receiver')
  scope: subscription
  properties: { principalId: principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0') }
}
