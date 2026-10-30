/** Shared constants for the organizations route group. */
import { arr, obj, ref } from "../../schema";
import { pathParam } from "../../operation";

export const orgId = pathParam("id", "Organization id (`org_…`).");
export const userId = pathParam("userId", "User id (`user_…`) of the membership.");
export const invId = pathParam("invId", "Organization invitation id (`orginv_…`).");
export const did = pathParam("did", "Organization domain id (`orgdom_…`).");
export const rid = pathParam("rid", "Membership request id (`orgreq_…`).");

export const paginatedList = (item: ReturnType<typeof ref>) => ({
  success: {
    status: 200 as const,
    schema: obj(
      { response: arr(item), data: arr(item), total_count: { type: "integer" } },
      { description: "`{ response: [...] }`, or `{ data, total_count }` when `?paginated=true`." },
    ),
  },
});
