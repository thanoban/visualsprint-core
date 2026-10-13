import { z } from "zod";
import type pg from "pg";
import {
  DeletionService,
  deletionParticipants,
  type DeletionAuthority,
  type DeletionPort,
  type DeletionParticipant,
} from "../application/deletion-service.js";
import { PostgresDeletions } from "./deletion-store.js";
import { HttpDeletionParticipant } from "./deletion-client.js";
export function deletionRuntime(
  pool: pg.Pool,
  authority: DeletionAuthority,
  key: CryptoKey,
  keyId: string,
  originsJson: string = "{}",
) {
  const origins = z
    .partialRecord(z.enum(deletionParticipants), z.string().url())
    .parse(JSON.parse(originsJson));
  const participants: Partial<Record<DeletionParticipant, DeletionPort>> = {};
  for (const [name, origin] of Object.entries(origins))
    participants[name as DeletionParticipant] = new HttpDeletionParticipant(
      name as DeletionParticipant,
      origin,
      key,
      keyId,
    );
  const repository = new PostgresDeletions(pool);
  return { repository, service: new DeletionService(repository, authority, participants) };
}
