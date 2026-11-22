import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-500",
        warning: "border-amber-500/30 bg-amber-500/15 text-amber-500",
        destructive: "border-red-500/30 bg-red-500/15 text-red-500",
        info: "border-sky-500/30 bg-sky-500/15 text-sky-500",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
