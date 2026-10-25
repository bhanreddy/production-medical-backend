import { queryRaw } from "../lib/postgresDb";
import { AppError } from "../lib/appError";

/** Legacy cloud documents must reference cloud locations, not embedded-only IDs. */
export async function resolveCloudStoreContext(
  clinicId: string,
  requested: {
    store_id?: string | null;
    counter_id?: string | null;
    terminal_id?: string | null;
  },
) {
  const stores = await queryRaw<{ id: string; organization_id: string }>(
    "SELECT id, organization_id FROM stores WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
    [clinicId],
  );
  const store = requested.store_id
    ? stores.find((row) => row.id === requested.store_id)
    : stores[0];
  if (requested.store_id && !store)
    throw new AppError(403, "Store does not belong to this clinic");
  const storeId = store?.id || null;
  const counterId = requested.counter_id || null;
  const terminalId = requested.terminal_id || null;
  if (
    counterId &&
    (!storeId ||
      !(
        await queryRaw(
          "SELECT id FROM counters WHERE id = ? AND store_id = ? AND deleted_at IS NULL",
          [counterId, storeId],
        )
      ).length)
  )
    throw new AppError(403, "Counter does not belong to this store");
  if (
    terminalId &&
    (!storeId ||
      !(
        await queryRaw(
          "SELECT id FROM terminals WHERE id = ? AND store_id = ? AND deleted_at IS NULL",
          [terminalId, storeId],
        )
      ).length)
  )
    throw new AppError(403, "Terminal does not belong to this store");
  return {
    organizationId: store?.organization_id || null,
    storeId,
    counterId,
    terminalId,
  };
}
