import { NextResponse } from 'next/server'

/** Healthcheck para monitoração de disponibilidade (RNF-03). */
export async function GET() {
  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )

  return NextResponse.json(
    { status: configured ? 'ok' : 'unconfigured', timestamp: new Date().toISOString() },
    { status: configured ? 200 : 503 },
  )
}
