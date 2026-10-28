import { UserProfile } from "@/components/orbit-widgets";

export default function UserProfilePage() {
  return (
    <div className="flex justify-center py-10">
      <UserProfile routing="path" path="/user" />
    </div>
  );
}
