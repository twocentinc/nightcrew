import { withEventMeta } from "@orpc/server";
import { type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Service, fail } from "../engine/service.js";
import { terminal } from "../schemas/common.js";
import { tokenHash } from "../storage/config.js";

export function createEventStream(service: Service) {
  let streams = 0;
  const events = async (
    kind: "run" | "chat",
    resourceID: string,
    afterEventID: number | undefined,
    request: IncomingMessage,
  ) => {
    const header = request.headers["last-event-id"];
    if (
      Array.isArray(header) ||
      (header !== undefined && !/^\d+$/.test(header))
    )
      fail("invalid_event_id");
    if (
      header !== undefined &&
      afterEventID !== undefined &&
      Number(header) !== afterEventID
    )
      fail("event_id_mismatch");
    let position = afterEventID ?? Number(header ?? 0);
    const get = async () =>
      kind === "run" ? await service.run(resourceID) : service.chat(resourceID);
    const initial = await get();
    if (position > initial.events.length) fail("invalid_event_id");
    if (streams >= 10) fail("stream_capacity", 429);
    streams++;
    async function* stream() {
      let attemptID = "",
        offset = 0;
      try {
        while (true) {
          if (
            tokenHash(request.headers.authorization?.slice(7) ?? "") !==
            service.storage.store.config.rootTokenHash
          )
            fail("unauthorized", 401);
          const record = await get();
          for (const e of record.events.slice(position)) {
            position = e.sequence;
            yield withEventMeta(
              {
                eventID: e.sequence,
                type: e.type,
                at: e.at,
                resourceID,
                segment: e.segment,
                data: e.data,
              },
              { id: String(e.sequence) },
            );
          }
          const provisional = service.provisional.get(resourceID);
          if (provisional) {
            if (provisional.attemptID !== attemptID) {
              attemptID = provisional.attemptID;
              offset = 0;
              yield {
                eventID: position,
                type: "textDelta",
                at: new Date().toISOString(),
                resourceID,
                segment:
                  kind === "run"
                    ? "segment" in record
                      ? record.segment
                      : 0
                    : 0,
                data: { attemptID, reset: true, text: "" },
              };
            }
            if (provisional.text.length > offset) {
              yield {
                eventID: position,
                type: "textDelta",
                at: new Date().toISOString(),
                resourceID,
                segment: "segment" in record ? record.segment : 0,
                data: {
                  attemptID,
                  reset: false,
                  text: provisional.text.slice(offset),
                },
              };
              offset = provisional.text.length;
            }
          }
          if (terminal(record.state)) return;
          await delay(250);
        }
      } finally {
        streams--;
      }
    }
    return stream();
  };
  return events;
}
