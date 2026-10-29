import { PageHeader } from "@/components/page-header";
import { SetupRequired } from "@/components/setup-required";
import { SeedManager } from "@/components/seed-manager";
import { readSecretKey } from "@/lib/env";
import { loadPlaygroundUsers } from "@/lib/seed";

export const dynamic = "force-dynamic";

export default async function SeedPage() {
  if (!readSecretKey()) {
    return (
      <div className="space-y-8">
        <PageHeader
          title="Seed data"
          description="Create users, organizations and sign-in links through the Backend API."
        />
        <SetupRequired
          title="Seed data needs the secret key"
          description="Creating users and organizations calls the Backend API with the instance secret key. The publishable key is not enough."
          missing="ORBITID_SECRET_KEY is not set"
        />
      </div>
    );
  }

  const result = await loadPlaygroundUsers();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Seed data"
        description="Create users, organizations and sign-in links through the Backend API, then remove exactly what this tool made."
      />
      <SeedManager
        users={result.users}
        loadError={result.ok ? undefined : result.error}
        scanned={result.ok ? result.scanned : undefined}
      />
    </div>
  );
}
