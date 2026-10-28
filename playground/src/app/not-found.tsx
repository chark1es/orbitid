import Link from "next/link";

export default function NotFound() {
  return (
    <section className="border px-5 py-6">
      <h1 className="text-lg">No page at this address</h1>
      <p className="mt-1 max-w-[65ch] text-muted-foreground">
        The test site has pages for setup, sign-in, account, organizations, inspector, API lab, webhooks and seed data.
      </p>
      <Link href="/" className="mt-4 inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">
        Go to setup
      </Link>
    </section>
  );
}
