import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send, Loader2, Bot, User } from 'lucide-react'
import { chatApi } from '@/services/api'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const SUGGESTIONS = [
  'What documents do I need to file a claim?',
  'How long does claim processing take?',
  'What happens if my policy lapsed?',
  'Can I file a partial claim?',
]

export default function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: "Hi, I'm your claims assistant. I understand this may be a difficult time for you, and I'm here to help make the process as smooth as possible. I can guide you through filing a death benefits claim, explain what documents you'll need, or answer any questions about the process. How can I help you today?" },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-open after a short delay on first visit
  useEffect(() => {
    const timer = setTimeout(() => setOpen(true), 1500)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return

    const userMsg: Message = { role: 'user', content: text.trim() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }))
      const data = await chatApi.sendMessage(text.trim(), history)
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: "Sorry, I'm having trouble connecting. Please try again in a moment." }])
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(input)
  }

  const showSuggestions = messages.length <= 1 && !loading

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-105"
          aria-label="Open chat assistant"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-96 h-[520px] bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-primary-600 to-primary-700 px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
                <Bot className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="text-white font-medium text-sm">Claims Assistant</p>
                <p className="text-white/70 text-xs">AI-powered help</p>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-white/80 hover:text-white transition-colors"
              aria-label="Close chat"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="h-3.5 w-3.5 text-primary-600" />
                  </div>
                )}
                <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-primary-600 text-white rounded-br-md'
                    : 'bg-gray-100 text-gray-800 rounded-bl-md'
                }`}>
                  {msg.content}
                </div>
                {msg.role === 'user' && (
                  <div className="w-7 h-7 bg-gray-200 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <User className="h-3.5 w-3.5 text-gray-600" />
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex gap-2 justify-start">
                <div className="w-7 h-7 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <Bot className="h-3.5 w-3.5 text-primary-600" />
                </div>
                <div className="bg-gray-100 px-4 py-2 rounded-2xl rounded-bl-md">
                  <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Suggestions */}
          {showSuggestions && (
            <div className="px-4 pb-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(s)}
                  className="text-xs px-2.5 py-1.5 bg-primary-50 text-primary-700 rounded-full hover:bg-primary-100 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <form onSubmit={handleSubmit} className="px-3 py-2 border-t border-gray-100 flex gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about claims..."
              className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-full focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-200"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="w-9 h-9 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 text-white rounded-full flex items-center justify-center transition-colors flex-shrink-0"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </>
  )
}
