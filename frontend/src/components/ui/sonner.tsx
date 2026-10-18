import { Toaster as Sonner, toast, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      position="top-center"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-emerald-600 shrink-0" />,
        info: <InfoIcon className="size-4 text-indigo-600 shrink-0" />,
        warning: <TriangleAlertIcon className="size-4 text-amber-500 shrink-0" />,
        error: <OctagonXIcon className="size-4 text-rose-600 shrink-0" />,
        loading: <Loader2Icon className="size-4 animate-spin text-zinc-500 shrink-0" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-white group-[.toaster]:text-zinc-900 group-[.toaster]:border-zinc-200 group-[.toaster]:shadow-lg group-[.toaster]:rounded-xl text-xs font-medium py-3 px-4",
          description: "group-[.toast]:text-zinc-500 text-[11px]",
          actionButton: "group-[.toast]:bg-zinc-900 group-[.toast]:text-zinc-50",
          cancelButton: "group-[.toast]:bg-zinc-100 group-[.toast]:text-zinc-600",
        },
      }}
      style={
        {
          "--normal-bg": "#ffffff",
          "--normal-text": "#18181b",
          "--normal-border": "#e4e4e7",
          "--border-radius": "0.75rem",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster, toast }
