import { cn } from "@/lib/utils";

export function Card({ className, ...props }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-none",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }) {
  return <div className={cn("flex flex-col space-y-1 px-4 py-3.5 sm:px-5 sm:py-4 pb-2.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }) {
  return <h3 className={cn("font-semibold leading-snug tracking-tight text-[13px]", className)} {...props} />;
}

export function CardDescription({ className, ...props }) {
  return <p className={cn("text-xs text-muted-foreground leading-relaxed", className)} {...props} />;
}

export function CardContent({ className, ...props }) {
  return <div className={cn("px-4 pb-4 pt-2 sm:px-5 sm:pb-5", className)} {...props} />;
}
