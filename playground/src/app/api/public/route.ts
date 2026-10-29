import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "x-demo-check": "none" };

export async function GET() {
  return NextResponse.json(
    {
      endpoint: "public",
      ok: true,
      at: new Date().toISOString(),
      detail: "This handler never calls auth(). It answers with and without a token.",
    },
    { headers: HEADERS },
  );
}
