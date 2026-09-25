- radio "自定义地址" [checked]
- text: 自定义地址
- textbox "自定义地址" [invalid]:
  - /placeholder: https://npm.example.com/
  - text: invalid-registry
- alert: 请输入以 http:// 或 https:// 开头的地址
- text: 填写内网或私有 npm 源地址，以 http:// 或 https:// 开头。若为需要登录的源，请把凭据放在本机的 ~/.npmrc 里。

{
  "outline": "none",
  "boxShadow": "none"
}
