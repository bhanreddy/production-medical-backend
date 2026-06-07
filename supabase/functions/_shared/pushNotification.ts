interface PushMessage {
  to: string | string[]
  title: string
  body: string
  data?: Record<string, unknown>
  channelId?: string
  priority?: 'default' | 'normal' | 'high'
  badge?: number
}

// Expo Push API — chunks into batches of 100 (Expo limit)
export async function sendPushNotifications(messages: PushMessage[]): Promise<void> {
  const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
  const CHUNK_SIZE = 100

  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE)
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(chunk),
    })

    const result = await response.json()

    // Log any errors per token
    result.data?.forEach((ticket: any, idx: number) => {
      if (ticket.status === 'error') {
        console.error(`Push failed for token ${chunk[idx].to}:`, ticket.message)
        // If DeviceNotRegistered → deactivate token in DB
        // handled in calling function if needed, but not implemented here yet
      }
    })
  }
}
