[
  {
    "language": "mermaid",
    "lines": [
      [
        {
          "text": "flowchart",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": " LR",
          "style": "color: var(--shiki-token-function);"
        }
      ],
      [
        {
          "text": "  A",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "[",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": "输入",
          "style": "color: var(--shiki-token-string);"
        },
        {
          "text": "]",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": " --",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": "> B[共享渲染器] ",
          "style": "color: var(--shiki-token-string);"
        },
        {
          "text": "-->",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": " C",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "[",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": "图形预览",
          "style": "color: var(--shiki-token-string);"
        },
        {
          "text": "]",
          "style": "color: var(--shiki-token-keyword);"
        }
      ]
    ]
  },
  {
    "language": "dot",
    "lines": [
      [
        {
          "text": "digraph",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": " { ",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "rankdir",
          "style": "color: var(--shiki-token-constant);"
        },
        {
          "text": "=LR; Input ",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "->",
          "style": "color: var(--shiki-token-keyword);"
        },
        {
          "text": " Preview }",
          "style": "color: var(--shiki-foreground);"
        }
      ]
    ]
  },
  {
    "language": "svg",
    "lines": [
      [
        {
          "text": "<",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "svg",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " xmlns",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"http://www.w3.org/2000/svg\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " width",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"460\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " height",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"100\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " onload",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"parent.document.body.dataset.previewEscaped='yes'\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">",
          "style": "color: var(--shiki-foreground);"
        }
      ],
      [
        {
          "text": "<",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "rect",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " width",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"460\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " height",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"100\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " fill",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"lightblue\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": "/><",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "text",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " x",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"20\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " y",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"55\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">SVG preview</",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "text",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">",
          "style": "color: var(--shiki-foreground);"
        }
      ],
      [
        {
          "text": "<",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "script",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">parent.document.body.dataset.previewEscaped='yes';alert('unsafe SVG')</",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "script",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">",
          "style": "color: var(--shiki-foreground);"
        }
      ],
      [
        {
          "text": "<",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "image",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " href",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"https://preview.invalid/svg-image\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " width",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"1\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " height",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"1\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": "/>",
          "style": "color: var(--shiki-foreground);"
        }
      ],
      [
        {
          "text": "<",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "foreignObject",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " width",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"1\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " height",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"1\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": "><",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "div",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": " xmlns",
          "style": "color: var(--shiki-token-function);"
        },
        {
          "text": "=",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "\"http://www.w3.org/1999/xhtml\"",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": "><",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "script",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">alert('unsafe HTML')</",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "script",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": "></",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "div",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": "></",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "foreignObject",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">",
          "style": "color: var(--shiki-foreground);"
        }
      ],
      [
        {
          "text": "</",
          "style": "color: var(--shiki-foreground);"
        },
        {
          "text": "svg",
          "style": "color: var(--shiki-token-string-expression);"
        },
        {
          "text": ">",
          "style": "color: var(--shiki-foreground);"
        }
      ]
    ]
  }
]
