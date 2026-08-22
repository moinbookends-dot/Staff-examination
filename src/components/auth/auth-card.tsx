import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'

/**
 * The card every unauthenticated screen sits in.
 *
 * The heading is a real <h1>, not a <CardTitle>. CardTitle renders a <div>, so
 * before this every auth page's only heading was the product name in the
 * layout — meaning "Bookends Learning" was the h1 on the sign-in page, the
 * register page and the reset page alike, and a screen-reader user jumping by
 * heading learned nothing about which of the five screens they were on.
 * The page's own name is the heading that belongs here.
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card className="[--card-spacing:--spacing(6)]">
      <CardHeader>
        <h1 className="font-heading text-lg font-semibold tracking-tight">{title}</h1>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
