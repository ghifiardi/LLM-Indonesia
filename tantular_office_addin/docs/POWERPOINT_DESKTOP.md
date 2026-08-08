# Testing Tantular in PowerPoint Desktop

Tantular is an **Office.js task-pane add-in**, not a web-only app. The same
`manifest.xml` can be sideloaded into PowerPoint desktop on macOS or Windows.

Important distinction:

- **Office.js desktop add-in**: cross-platform, uses the Office webview runtime,
  same manifest/task pane code. This is what Tantular currently is.
- **Native/VSTO/COM add-in**: Windows-only native Office automation. More power,
  but not cross-platform and not available for PowerPoint on Mac.

For your MacBook, the recommended path is Office.js sideloading into PowerPoint
for Mac.

## 1. Start Tantular local server

From this folder:

```bash
npm run dev
```

Then open once in a browser and accept/trust the certificate if prompted:

```text
https://localhost:3000/src/taskpane.html
```

The desktop add-in still loads this HTTPS URL in a webview, so the certificate
must be trusted by macOS/PowerPoint.

## 2. Sideload on PowerPoint for Mac

Copy `manifest.xml` into the Office add-ins WEF folder:

```bash
mkdir -p "$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef"
cp manifest.xml "$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/manifest.xml"
```

Then fully quit and reopen PowerPoint desktop.

In PowerPoint desktop, look under:

```text
Insert → My Add-ins / Office Add-ins → Shared Folder / Developer Add-ins → Tantular
```

Exact menu labels vary by Office build.

## 3. Use the local model

Keep Ollama running on:

```text
http://127.0.0.1:11434
```

Tantular settings:

```text
Endpoint: http://127.0.0.1:11434/v1/chat/completions
Model umum / chat: qwen3:8b
Model deck: tantular-office:0.3-8b
Model vision: llama3.2-vision
```

Create the deck model profile once before opening PowerPoint:

```bash
npm run model:office
```

The older `tantular:0.2-id-3b-lora` remains useful for short support/safety
responses, but it should not be selected as **Model deck** because its training
and 220-token generation profile are not suitable for long deck plans.

## 4. Recommended Desktop behavior

PowerPoint desktop may handle some insertion APIs better than PowerPoint web,
but **Download .pptx** remains the most reliable output path. Use:

```text
Deck Studio → upload image/text → Buat & Download Deck
```

Then open the downloaded `.pptx` in desktop PowerPoint.

## 5. Clearing old versions

If PowerPoint keeps loading an old manifest, delete the copied manifest:

```bash
rm "$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/manifest.xml"
```

Then copy the current `manifest.xml` again and restart PowerPoint.
