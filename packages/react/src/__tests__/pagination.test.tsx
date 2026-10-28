import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePagedResource } from "../hooks/internal/usePagedResource";
import type { PaginatedResult, PaginationQuery } from "../provider/types";

interface Row {
  id: string;
}

type FetchArgs = PaginationQuery & { limit: number; offset: number; page: number };
type Fetcher = (args: FetchArgs) => Promise<PaginatedResult<Row>>;

const rows = (ids: string[], totalCount = 5): PaginatedResult<Row> => ({
  data: ids.map((id) => ({ id })),
  totalCount,
});

function Probe({
  resourceKey,
  fetcher,
  pageSize = 2,
  infinite = false,
  keepPreviousData = false,
  enabled = true,
}: {
  resourceKey: string;
  fetcher: Fetcher;
  pageSize?: number;
  infinite?: boolean;
  keepPreviousData?: boolean;
  enabled?: boolean;
}) {
  const resource = usePagedResource<Row>({
    key: resourceKey,
    fetcher,
    pageSize,
    infinite,
    keepPreviousData,
    enabled,
  });
  return (
    <>
      <p data-testid="state">
        {JSON.stringify({
          ids: resource.data.map((row) => row.id),
          count: resource.count,
          page: resource.page,
          pageCount: resource.pageCount,
          isLoading: resource.isLoading,
          isFetching: resource.isFetching,
          hasNext: resource.hasNextPage,
          hasPrev: resource.hasPreviousPage,
        })}
      </p>
      <button onClick={() => void resource.fetchNext()}>next</button>
      <button onClick={() => void resource.fetchPrevious()}>previous</button>
      <button onClick={() => void resource.revalidate()}>revalidate</button>
      <button onClick={() => resource.setData([{ id: "local" }])}>set</button>
    </>
  );
}

const read = () => JSON.parse(screen.getByTestId("state").textContent!) as Record<string, unknown>;

describe("usePagedResource", () => {
  it("loads page 1 and paginates forward", async () => {
    const fetcher = vi.fn<Fetcher>(async ({ page }) => (page === 1 ? rows(["1", "2"]) : rows(["3", "4"])));
    render(<Probe resourceKey="basic" fetcher={fetcher} />);

    await waitFor(() => expect(read().ids).toEqual(["1", "2"]));
    expect(read()).toMatchObject({ count: 5, page: 1, pageCount: 3, hasNext: true, hasPrev: false, isLoading: false });
    expect(fetcher).toHaveBeenCalledWith({ limit: 2, offset: 0, page: 1 });

    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(read().ids).toEqual(["3", "4"]));
    expect(read()).toMatchObject({ page: 2, hasPrev: true });
    expect(fetcher).toHaveBeenLastCalledWith({ limit: 2, offset: 2, page: 2 });

    fireEvent.click(screen.getByText("previous"));
    await waitFor(() => expect(read().page).toBe(1));
  });

  it("accumulates pages in infinite mode", async () => {
    const fetcher = vi.fn<Fetcher>(async ({ page }) => (page === 1 ? rows(["1", "2"]) : rows(["3", "4"])));
    render(<Probe resourceKey="infinite" fetcher={fetcher} infinite />);

    await waitFor(() => expect(read().ids).toEqual(["1", "2"]));
    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(read().ids).toEqual(["1", "2", "3", "4"]));
  });

  it("keeps previous data while the next page is loading", async () => {
    let resolvePage: (value: PaginatedResult<Row>) => void = () => {};
    const fetcher = vi.fn<Fetcher>(({ page }) =>
      page === 1 ? Promise.resolve(rows(["1", "2"])) : new Promise<PaginatedResult<Row>>((resolve) => {
        resolvePage = resolve;
      }),
    );

    render(<Probe resourceKey="keep-previous" fetcher={fetcher} keepPreviousData />);
    await waitFor(() => expect(read().ids).toEqual(["1", "2"]));

    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(read().isFetching).toBe(true));
    expect(read().ids).toEqual(["1", "2"]);

    resolvePage(rows(["3", "4"]));
    await waitFor(() => expect(read().ids).toEqual(["3", "4"]));
  });

  it("shows isLoading until the first page arrives", async () => {
    let resolvePage: (value: PaginatedResult<Row>) => void = () => {};
    const fetcher = vi.fn<Fetcher>(
      () =>
        new Promise<PaginatedResult<Row>>((resolve) => {
          resolvePage = resolve;
        }),
    );

    render(<Probe resourceKey="loading" fetcher={fetcher} />);
    expect(read().isLoading).toBe(true);

    resolvePage(rows(["1"], 1));
    await waitFor(() => expect(read().isLoading).toBe(false));
    expect(read().ids).toEqual(["1"]);
  });

  it("does not fetch when disabled", async () => {
    const fetcher = vi.fn<Fetcher>(async () => rows(["1"]));
    render(<Probe resourceKey="disabled" fetcher={fetcher} enabled={false} />);

    await waitFor(() => expect(read().isFetching).toBe(false));
    expect(fetcher).not.toHaveBeenCalled();
    expect(read().ids).toEqual([]);
  });

  it("revalidates the current page and replaces data on demand", async () => {
    const fetcher = vi.fn<Fetcher>(async () => rows(["1", "2"], 2));
    render(<Probe resourceKey="revalidate" fetcher={fetcher} />);
    await waitFor(() => expect(read().ids).toEqual(["1", "2"]));

    fetcher.mockResolvedValueOnce(rows(["9", "8"], 2));
    fireEvent.click(screen.getByText("revalidate"));
    await waitFor(() => expect(read().ids).toEqual(["9", "8"]));
    expect(fetcher).toHaveBeenLastCalledWith({ limit: 2, offset: 0, page: 1, force: true });

    fireEvent.click(screen.getByText("set"));
    await waitFor(() => expect(read().ids).toEqual(["local"]));
  });

  it("seeds the first paint from the page cache on remount", async () => {
    const fetcher = vi.fn<Fetcher>(async () => rows(["1", "2"], 2));
    const first = render(<Probe resourceKey="cached" fetcher={fetcher} />);
    await waitFor(() => expect(read().ids).toEqual(["1", "2"]));
    first.unmount();

    const pending = vi.fn<Fetcher>(() => new Promise<PaginatedResult<Row>>(() => {}));
    render(<Probe resourceKey="cached" fetcher={pending} />);
    await waitFor(() => expect(read().ids).toEqual(["1", "2"]));
    expect(pending).toHaveBeenCalledTimes(1);
  });
});
