# ♟️ Dama Online

Site para jogar **dama brasileira** online com amigos. Crie uma sala, mande o link e joguem em tempo real.

## Funcionalidades
- Salas privadas com link/código para convidar amigos
- Regras oficiais da dama brasileira (captura obrigatória, lei da maioria, dama voadora)
- Validação de lances no servidor (ninguém trapaceia)
- Destaque das peças que podem mover, destinos possíveis e capturas em sequência
- Animações e sons
- Chat, indicador online/offline, espectadores
- Propor empate, desistir, revanche (com troca de cores) e placar da sala
- Reconexão automática (pode atualizar a página sem perder o lugar)
- Funciona no celular

## Como rodar
Precisa só do **Python 3.8+**, sem dependências:

```bash
python server.py
```

Abra http://localhost:8000. Para mudar a porta: `PORT=3000 python server.py` (no PowerShell: `$env:PORT=3000; python server.py`).

## Jogar com amigos
- **Mesma rede Wi-Fi:** mande o link usando o IP do seu computador, ex.: `http://192.168.0.10:8000/sala/ABCDE`
  (o Windows pode pedir para liberar o Python no firewall).
- **Pela internet (rápido):** use um túnel como `cloudflared tunnel --url http://localhost:8000` ou `ngrok http 8000`
  e compartilhe o endereço gerado.
- **Hospedagem permanente (grátis):** suba a pasta no GitHub e crie um *Web Service* no [Render](https://render.com)
  com o comando de start `python server.py` (a porta é lida da variável `PORT` automaticamente).

## Estrutura
| Arquivo | Função |
|---|---|
| `checkers.py` | Regras do jogo (geração e aplicação de lances) |
| `server.py` | Servidor HTTP + salas + tempo real via Server-Sent Events |
| `public/index.html` | Páginas inicial e da sala |
| `public/style.css` | Visual |
| `public/app.js` | Tabuleiro interativo, chat e comunicação com o servidor |

> As salas ficam na memória: se o servidor reiniciar, as partidas em andamento são perdidas.
