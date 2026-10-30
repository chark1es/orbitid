import { Button } from "@orbitid/ui";
import { Plus } from "lucide-react";
import { ConfirmDialog, MetaChip, PageHeader } from "./_config/ui";
import { useM2M } from "./_m2m/use-m2m";
import { MachinesSection, TokensSection } from "./_m2m/m2m-sections";
import { MachineSheet, MachineSecretSheet, MintTokenSheet } from "./_m2m/m2m-sheets";
import { EMPTY_MINT } from "./_m2m/model";

export default function Page() {
  const ctl = useM2M();
  const {
    rotating,
    setRotating,
    rotatingBusy,
    setMintOpen,
    setMint,
    setMintedToken,
    revoking,
    setRevoking,
    revokeBusy,
    machines,
    openCreate,
    rotateSecret,
    revokeToken,
  } = ctl;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Machine-to-machine"
        description="Machines authenticate as themselves, optionally scoped to other machines, and mint short-lived tokens."
        badge={<MetaChip>{machines.length} {machines.length === 1 ? "machine" : "machines"}</MetaChip>}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMint(EMPTY_MINT);
                setMintedToken(null);
                setMintOpen(true);
              }}
            >
              Mint test token
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" aria-hidden /> Create machine
            </Button>
          </div>
        }
      />

      <MachinesSection ctl={ctl} />

      <TokensSection ctl={ctl} />

      <MachineSheet ctl={ctl} />

      <MachineSecretSheet ctl={ctl} />

      <MintTokenSheet ctl={ctl} />

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => !open && setRotating(null)}
        title="Rotate machine secret?"
        description={
          <span>
            The existing secret for <strong>{rotating?.name}</strong> stops working immediately. Update the service with the new secret.
          </span>
        }
        confirmLabel="Rotate secret"
        destructive
        loading={rotatingBusy}
        onConfirm={() => void rotateSecret()}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revoke token?"
        description="Verification endpoints reject the token immediately."
        confirmLabel="Revoke token"
        destructive
        loading={revokeBusy}
        onConfirm={() => void revokeToken()}
      />
    </div>
  );
}
