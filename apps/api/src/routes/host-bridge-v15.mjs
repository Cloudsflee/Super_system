import { makeRoute, send, sendOneTimeSecret } from '../http.mjs';
import {
  createHostBridgePairing,
  exchangeHostBridgePairing,
  listHostBridgeDevices,
  revokeHostBridgeDevice
} from '../host-bridge-service.mjs';

export const hostBridgeV15Routes = [
  makeRoute('GET', '/assist/v3/host-bridge/pairing', async ({ res }) =>
    send(res, 200, { devices: await listHostBridgeDevices() })
  ),
  makeRoute('POST', '/assist/v3/host-bridge/pairing', async ({ res, body }) =>
    body.action === 'exchange'
      ? sendOneTimeSecret(res, 201, await exchangeHostBridgePairing(body))
      : send(res, 200, createHostBridgePairing())
  ),
  makeRoute('DELETE', '/assist/v3/host-bridge/devices/:id', async ({ res, params }) =>
    send(res, 200, await revokeHostBridgeDevice(params.id))
  )
];
