import { cn } from "@/lib/utils";

export function TabsList({ className, ...props }) {
  return (
    <div
      className={cn("inline-flex h-8 items-center justify-center rounded-lg bg-muted p-0.5 text-muted-foreground", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ active, className, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-all cursor-pointer",
        active ? "bg-background text-foreground shadow-xs" : "hover:text-foreground",
        className
      )}
      {...props}
    />
  );
}
