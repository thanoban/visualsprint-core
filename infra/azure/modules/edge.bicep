param name string
param originHost string
param frontendHost string
param environmentId string
param location string
param publicHostname string = ''
resource profile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: name
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: { originResponseTimeoutSeconds: 60 }
}
resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = { parent: profile, name: '${name}-endpoint', location: 'global', properties: { enabledState: 'Enabled' } }
resource domain 'Microsoft.Cdn/profiles/customDomains@2024-02-01' = if (!empty(publicHostname)) {
  parent: profile
  name: replace(publicHostname, '.', '-')
  properties: { hostName: publicHostname, tlsSettings: { certificateType: 'ManagedCertificate', minimumTlsVersion: 'TLS12' } }
}
resource groups 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = [for lane in ['api', 'web']: {
  parent: profile
  name: lane
  properties: { healthProbeSettings: { probePath: lane == 'api' ? '/health' : '/', probeProtocol: 'Https', probeRequestType: 'GET', probeIntervalInSeconds: 30 }, loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 0 } }
}]
resource origins 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = [for (host, i) in [originHost, frontendHost]: {
  parent: groups[i]
  name: 'private-origin'
  properties: { hostName: host, originHostHeader: host, httpsPort: 443, priority: 1, weight: 1000, enabledState: 'Enabled', enforceCertificateNameCheck: true, sharedPrivateLinkResource: { privateLink: { id: environmentId }, privateLinkLocation: location, groupId: 'managedEnvironments', requestMessage: 'Approve only after matching this named Front Door deployment.' } }
}]
resource routes 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = [for (lane, i) in ['api', 'web']: {
  parent: endpoint
  name: lane
  properties: { originGroup: { id: groups[i].id }, customDomains: empty(publicHostname) ? [] : [{ id: domain!.id }], patternsToMatch: lane == 'api' ? ['/api/*', '/oauth/*', '/webhooks/*', '/health'] : ['/*'], supportedProtocols: ['Https'], forwardingProtocol: 'HttpsOnly', httpsRedirect: 'Enabled', linkToDefaultDomain: 'Enabled', enabledState: 'Enabled' }
  dependsOn: [origins]
}]
resource waf 'Microsoft.Network/frontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: replace('${name}waf', '-', '')
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: { enabledState: 'Enabled', mode: 'Prevention', requestBodyCheck: 'Enabled' }
    managedRules: { managedRuleSets: [{ ruleSetType: 'Microsoft_DefaultRuleSet', ruleSetVersion: '2.1' }] }
    customRules: { rules: [
      { name: 'BlockInternalRoutes', enabledState: 'Enabled', priority: 1, ruleType: 'MatchRule', matchConditions: [{ matchVariable: 'RequestUri', operator: 'RegEx', matchValue: ['^/internal(/|[?]|$)'], negateCondition: false }], action: 'Block' }
      { name: 'BoundedRate', enabledState: 'Enabled', priority: 100, ruleType: 'RateLimitRule', rateLimitDurationInMinutes: 1, rateLimitThreshold: 1200, matchConditions: [{ matchVariable: 'RequestUri', operator: 'BeginsWith', matchValue: ['/'], negateCondition: false }], action: 'Block' }
    ] }
  }
}
resource security 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: profile
  name: 'waf'
  properties: { parameters: { type: 'WebApplicationFirewall', wafPolicy: { id: waf.id }, associations: [{ domains: concat([{ id: endpoint.id }], empty(publicHostname) ? [] : [{ id: domain!.id }]), patternsToMatch: ['/*'] }] } }
}
output defaultHost string = endpoint.properties.hostName
