import { SignUp } from "@/components/orbit-widgets";

export default function SignUpPage() {
  return (
    <div className="flex justify-center py-10">
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
    </div>
  );
}
