export const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    image.src = url
  })

export const loadImageMap = async <K extends string>(
  urls: Readonly<Record<K, string>>,
): Promise<Readonly<Record<K, HTMLImageElement>>> => {
  const entries = await Promise.all(
    (Object.entries(urls) as [K, string][]).map(async ([key, url]) => [key, await loadImage(url)] as const),
  )
  return Object.fromEntries(entries) as Record<K, HTMLImageElement>
}
