import {z} from "zod";
import {assertRuntimeRole,databasePool,ServiceIdentity,WorkOSVerifier} from "@visualsprint/platform";
import {AccountService} from "./application/account.js";
import {PostgresAccount} from "./infrastructure/store.js";
import {accountApp} from "./http/app.js";
const config=z.object({ACCOUNT_DATABASE_URL:z.string().min(1),DEFAULT_CELL_ID:z.string().min(1),
  WORKOS_CLIENT_ID:z.string().min(1),WORKOS_TOKEN_ISSUER:z.string().url(),WORKOS_TOKEN_AUDIENCE:z.string().min(1),
  SERVICE_TRUSTED_JWKS:z.string().min(1),PORT:z.coerce.number().int().positive().max(65535).default(4101)}).parse(process.env);
const pool=databasePool(config.ACCOUNT_DATABASE_URL); await assertRuntimeRole(pool);
const workos=new WorkOSVerifier({clientId:config.WORKOS_CLIENT_ID,issuer:config.WORKOS_TOKEN_ISSUER,audience:config.WORKOS_TOKEN_AUDIENCE});
const app=accountApp(new AccountService(new PostgresAccount(pool),config.DEFAULT_CELL_ID),token=>workos.verify(token),new ServiceIdentity("account",JSON.parse(config.SERVICE_TRUSTED_JWKS)));
app.addHook("onClose",()=>pool.end());
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{void app.close();});
await app.listen({host:"0.0.0.0",port:config.PORT});
