import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

/**
 * A placeholder for a line of text: a non-breaking space in the surrounding font, so its line box
 * is exactly the real text's, with the bar drawn over the middle (`.skel-text` in desk.css). Put it
 * where the text will go, inside the same element, and the page doesn't move when the text arrives.
 */
function SkelText({ width, className }: { width: number | string; className?: string }) {
  return (
    <span data-slot="skeleton" aria-hidden="true" className={cn("skel-text", className)} style={{ width }}>
      {" "}
    </span>
  )
}

export { Skeleton, SkelText }
