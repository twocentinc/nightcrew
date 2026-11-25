import { ORPCError, os, type InferSchemaInput } from "@orpc/server";
import { z } from "zod";
import { currentExecution, Execution } from "../../engine/execution/process.js";
import { NightcrewError } from "../../engine/protocol.js";
import type { Service } from "../../engine/service.js";
import { verifyBearerToken } from "../../storage/config.js";
import type { ManagementInput } from "./management.js";

type Handler = (service: Service, input: ManagementInput) => Promise<unknown>;
const empty = z.strictObject({});
export type OperationContext = {
  service: Service;
  local?: boolean;
  request?: { headers: { authorization?: string } };
};
function procedure<I extends z.ZodType, O extends z.ZodType>(
  name: string,
  input: I,
  output: O,
  operand: string,
  mutates: boolean,
  confirmation: boolean,
  localOnly: boolean,
  manage: Handler,
) {
  return os
    .$context<OperationContext>()
    .use(async ({ context, next }) => {
      if (!context.local) {
        const header = context.request?.headers.authorization;
        if (
          !verifyBearerToken(
            header,
            context.service.storage.store.config.rootTokenHash,
          )
        )
          throw new ORPCError("UNAUTHORIZED");
        if (localOnly)
          throw new ORPCError("FORBIDDEN", {
            message: "This operation requires local filesystem access",
          });
      }
      return next();
    })
    .route({
      method: "POST",
      path: `/v1/operations/${name.replaceAll(" ", "/")}`,
      summary: name,
    })
    .input(
      z.strictObject({
        resourceID:
          operand === "required"
            ? z.string().min(1).max(1000)
            : z.never().optional(),
        request: input,
        dryRun: z.boolean().default(false),
        yes: z.boolean().default(false),
      }),
    )
    .output(output)
    .handler(async ({ input: value, context }) => {
      if (confirmation && !value.yes && !value.dryRun)
        throw new ORPCError("BAD_REQUEST", {
          message: "confirmation_required",
        });
      const invoke = async () => {
        const result = await manage(context.service, {
          command: name,
          ...value,
        });
        const parsed = output.safeParse(result);
        if (!parsed.success)
          throw new NightcrewError(
            "protocol.invalidResult",
            "Operation result does not match its contract",
            1,
          );
        return parsed.data as InferSchemaInput<O>;
      };
      return currentExecution()
        ? invoke()
        : new Execution(90000, mutates && !value.dryRun).run(invoke);
    });
}
export type OperationDefinition = {
  name: string;
  description: string;
  scope: "management" | "daemon";
  operand: "none" | "required";
  mutates: boolean;
  confirmation: boolean;
  options: string[];
  request: z.ZodType;
  result: z.ZodType;
  localOnly: boolean;
  procedure: ReturnType<typeof procedure>;
};

export function createOperations<R extends Record<string, z.ZodType>>(
  requests: R,
  handle: Handler,
) {
  function inputFor<N extends string>(
    name: N,
  ): N extends keyof R ? R[N] : typeof empty {
    return (requests[name] ?? empty) as N extends keyof R ? R[N] : typeof empty;
  }
  function defineOperation<N extends string, O extends z.ZodType>(
    name: N,
    description: string,
    result: O,
    mutates = false,
    operand: "none" | "required" = "none",
    confirmation = false,
    scope: "management" | "daemon" = "management",
    options: string[] = [],
  ) {
    const request = inputFor(name);
    const localOnly = ["runs export", "runs verify"].includes(name);
    const proc = procedure(
      name,
      request,
      result,
      operand,
      mutates,
      confirmation,
      localOnly,
      handle,
    );
    return {
      name,
      description,
      scope,
      operand,
      mutates,
      confirmation,
      options,
      request: proc["~orpc"].inputSchema!.shape.request,
      result: proc["~orpc"].outputSchema!,
      localOnly,
      procedure: proc,
    };
  }

  return defineOperation;
}
