import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none tracking-tight transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-border/70 bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        success: "border-emerald-500/25 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
        warning: "border-amber-500/25 bg-amber-500/12 text-amber-700 dark:text-amber-400",
        destructive: "border-red-500/25 bg-red-500/12 text-red-700 dark:text-red-400",
        info: "border-sky-500/25 bg-sky-500/12 text-sky-700 dark:text-sky-400",
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
