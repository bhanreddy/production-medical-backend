import type { RequestHandler } from "express";
import { withPostgresTransaction } from "./postgresDb";

/** Commit all business writes before acknowledging a successful request. */
export function transactionalRoute(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    const originalJson = res.json;
    let responseBody: unknown;
    let hasResponse = false;
    let failure: unknown;
    res.json = (body: unknown) => {
      responseBody = body;
      hasResponse = true;
      return res;
    };
    try {
      await withPostgresTransaction(async () => {
        await handler(req, res, (error) => {
          failure = error || new Error("Transaction handler did not complete");
        });
        if (failure) throw failure;
      });
      res.json = originalJson;
      if (hasResponse) res.json(responseBody);
      else next();
    } catch (error) {
      res.json = originalJson;
      // Discard an uncommitted success status before the error handler runs.
      res.status(500);
      next(error);
    }
  };
}
