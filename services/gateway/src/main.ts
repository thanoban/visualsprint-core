import {importJWK} from "jose";
import {z} from "zod";
import {WorkOSVerifier} from "@visualsprint/platform";
import {gatewayApp} from "./http/app.js";
const config=z.object({ACCOUNT_INTERNAL_URL:z.string().url(),CELL_ROUTES:z.string().min(1),SERVICE_PRIVATE_JWK:z.string().min(1),SERVICE_KEY_ID:z.string().min(1),
  WORKOS_CLIENT_ID:z.string().min(1),WORKOS_TOKEN_ISSUER:z.string().url(),WORKOS_TOKEN_AUDIENCE:z.string().min(1),PORT:z.coerce.number().int().positive().max(65535).default(4100)}).parse(process.env);
const cell=z.object({workspace:z.string().url().optional(),ingest:z.string().url().optional(),integration:z.string().url().optional(),intelligence:z.string().url().optional(),workflow:z.string().url().optional(),reporting:z.string().url().optional()}).strict();
const cells=z.record(z.string().regex(/^[a-z0-9-]{1,100}$/),cell).parse(JSON.parse(config.CELL_ROUTES));
for(const value of [config.ACCOUNT_INTERNAL_URL,...Object.values(cells).flatMap(cell=>Object.values(cell).filter((value):value is string=>typeof value==="string"))]) {
  const url=new URL(value);
  if(url.username||url.password||url.hash||(url.protocol!=="https:" && !(process.env.NODE_ENV!=="production" && url.protocol==="http:" && ["localhost","127.0.0.1"].includes(url.hostname))))throw new Error("INVALID_INTERNAL_ORIGIN");
}
const key=await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK),"EdDSA");
if(key instanceof Uint8Array)throw new Error("INVALID_SERVICE_SIGNING_KEY");
const workos=new WorkOSVerifier({clientId:config.WORKOS_CLIENT_ID,issuer:config.WORKOS_TOKEN_ISSUER,audience:config.WORKOS_TOKEN_AUDIENCE});
const app=gatewayApp({accountUrl:config.ACCOUNT_INTERNAL_URL,cells,privateKey:key,keyId:config.SERVICE_KEY_ID},token=>workos.verify(token));
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{void app.close();});
await app.listen({host:"0.0.0.0",port:config.PORT});
