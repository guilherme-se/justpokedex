# 🔴 JustPokédex — Poké Leitor & Analisador de IVs

<div align="center">

![UserScript](https://img.shields.io/badge/UserScript-v3.0-e5383b?style=for-the-badge&logo=javascript)
![Target Game](https://img.shields.io/badge/Jogo-Poke_Idle_World-f1c644?style=for-the-badge&logo=pokemon)
![Status](https://img.shields.io/badge/Status-Ativo-4caf50?style=for-the-badge)

*Um assistente de Pokédex inteligente para **Poké Idle World** com leitura automática, calculador de IVs em tempo real, rastreador de combate via WebSocket e comparador de espécimes.*

</div>

---

> [!NOTE]
> **🌐 Central de Documentação Interativa**:
> Para visualizar a documentação completa com layout estilizado, acesse o arquivo **[`index.html`](file:///c:/Users/gse/Desktop/justpokedex/index.html)** diretamente no seu navegador!

---

## ⚡ Recursos em Destaque

| Ícone | Funcionalidade | Descrição |
| :---: | :--- | :--- |
| 🐭 | **Leitura por Hover** | Detecta e lê os dados do Pokémon ao passar o mouse sobre itens do inventário (`.inv-tip`). |
| 🏪 | **Mercado Global** | Clique em qualquer Pokémon listado no mercado para ler seus status e estimar seus IVs na hora. |
| ⚔️ | **WebSocket Combat Proxy** | Intercepta o tráfego do jogo para registrar dano real, efetividades ($2x/4x$) e golpes sofridos. |
| 📊 | **Cálculo de IV & Potencial** | Estima IVs exatos de $0$ a $32$ por atributo ($0$ a $192$ no total) e calcula o **Potencial do Exemplar** ($0\%$ a $100\%$). |
| ⚠️ | **Alerta de Nível Mínimo** | Alerta automaticamente quando o Pokémon está abaixo do Nv. 15 devido a margens de arredondamento. |
| 🛡️ | **Efetividade de Tipos** | Matriz automática de fraquezas e vantagens de ataque ($2x, 4x$) e defesa (fraquezas e imunidades). |
| 🚀 | **Atalho PIW Tools (Rota)** `✨ NOVO` | Botão na aba Pokémon que abre o simulador do **PIW Tools** (`_blank`) com status, nível e nome auto-preenchidos via GET. |
| 🎁 | **Lembrete de Resgate Diário (24h)** `✨ NOVO` | Monitora a coleta do Daily Gift (`button.dg-resgatar`) e exibe contagem regressiva de 24h exatas a partir do momento da coleta. |
| ✨ | **Detector & Contador Shiny (WebSocket)** `✨ NOVO` | Intercepta pacotes do mapa em tempo real via WebSocket, reproduz o áudio clássico de Shiny do *Pokémon Legends: Arceus* (🔊), exibe alertas instantâneos ao detectar `"shiny": true` e mantém um contador persistente com botão de zerar (`🔄`). |
| ⌨️ | **Atalho de Reabertura (Alt+P)** `✨ NOVO` | Atalho universal de teclado (`Alt + P`) para abrir ou fechar a Pokédex instantaneamente sem poluir a tela e sem precisar atualizar a página. |
| 📊 | **Histórico & Cache Local** | Armazena análises recentes e respostas da API em `localStorage` para consultas instantâneas. |

---

## 📐 Explicação Matemática Detalhada (v3.0)

> 🤝 **Créditos & Agradecimentos:** O cálculo de IV do JustPokédex é baseado nas fórmulas da ferramenta [PIW Tools](https://piwtools.vercel.app/), desenvolvida com a colaboração e apoio do **@bar** (criador da ferramenta).

### 1️⃣ Equação Direta de Atributo

$$\text{Stat Final } (S) = \text{round}\left( (B + 2 \cdot IV) \cdot \left(\frac{L}{100}\right) \cdot Q^{e} \right)$$

- **$S$ (Stat)**: Atributo final exibido no jogo.
- **$B$ (Base Stat)**: Atributo base da espécie (PokeAPI).
- **$IV$**: Crescimento individual ($0$ a $32$ por atributo \| $0$ a $192$ no total dos 6 atributos).
- **$L$ (Level)**: Nível do Pokémon.
- **$Q$ (Quality)**: Multiplicador de Raridade ($1.00$ a $4.00+$).
- **$e$ (Expoente)**: HP/Vel = $0.95$ \| Outros (Atk, Def, SpA, SpD) = $0.80$.

### 2️⃣ Inversão por Regressão Float & Ceil

$$\text{Fator } (F) = \left(\frac{L}{100}\right) \cdot Q^{e}$$

$$IV_{\text{float}} = \frac{\left(\frac{S}{F}\right) - B}{2}$$

$$IV_{\text{Total}} = \text{Math.ceil}\left(\sum IV_{\text{float}}\right)$$

$$\text{Poder Oficial} = (\text{Soma dos 6 Stats}) \cdot Q$$

---

## 🏆 Tabela de Avaliação e Etiquetas Oficiais

### 📊 Avaliação por Potencial de IV (%)

| Faixa (%) | Classificação | Descrição Técnica |
| :--- | :--- | :--- |
| **95% – 100%** | 🟢 **Excepcional** | Exemplar extremamente próximo da perfeição máxima. |
| **85% – 94.9%** | 🔵 **Excelente** | Ótimos atributos e excelente eficiência geral. |
| **72% – 84.9%** | 🟢 **Muito Bom** | Pokémon forte, bem acima da média selvagem. |
| **58% – 71.9%** | 🔷 **Bom** | Bom equilíbrio de atributos para uso geral. |
| **42% – 57.9%** | 🟡 **Mediano** | Possui atributos razoáveis. |
| **0% – 41.9%** | 🔴 **Fraco** | Baixo potencial geral em comparação ao máximo. |

### 🏷️ Etiquetas Oficiais de Qualidade (Game System)

| Qualidade | Etiqueta Oficial | Origem / Condição |
| :--- | :--- | :--- |
| **< 1.0** | ⚪ **Fraca** | Captura Selvagem |
| **1.0 – 1.1** | ⚪ **Comum** | Captura Selvagem |
| **1.1 – 1.3** | 🟢 **Incomum** | Captura Selvagem |
| **1.3 – 1.5** | 🔵 **Rara** | Captura Selvagem |
| **1.5 – 1.7** | 🟣 **Épica** | Captura Selvagem |
| **1.7 – 2.0** | 🟡 **Lendária** | Captura Rara (Teto Selvagem 1.80) |
| **2.0 – 3.0** | 🔴 **Mítica** | Breeding / Shinies / Eventos |
| **3.0 – 4.0** | 🟠 **Anciã** | Breeding / Shinies |
| **4.0+** | 🩵 **Divina** | Breeding / Shinies |

> 💡 **Nota Oficial:** Os tiers *Mítica, Anciã e Divina* (qualidade 2.0+) **NÃO** saem em capturas selvagens normais (teto 1.8) — são alcançados via Breeding, Shinies e Eventos.

---

## 📥 Guia de Instalação Rápida

### Passo 1: Instale a Extensão
Instale um gerenciador de UserScripts no seu navegador Chromium ou Firefox:
- **Tampermonkey** (Recomendado para Chrome/Edge/Brave)
- **Violentmonkey** (Opção open-source)

### Passo 2: Adicione o Código
Crie um novo script na extensão e cole o conteúdo oficial obtido direto do **[GitHub Repositório Oficial](https://github.com/guilherme-se/justpokedex)**.

Acesse **[poke.idleworld.online](https://poke.idleworld.online/)** e aproveite!

> 🎥 **Precisa de ajuda na instalação?**  
> Assista ao tutorial em vídeo passo a passo no Loom: **[▶ Ver Vídeo Tutorial no Loom](https://www.loom.com/share/cc6d34c8522b451abfe601bcf66e5657)**

---

## 🛡️ ATENÇÃO: Transparência & Segurança do Código

> ⚠️ **ÚNICO LINK OFICIAL E SEGURO DO PROJETO:**  
> **Nunca baixe ou instale arquivos de código enviados por terceiros** no Discord, WhatsApp ou redes sociais! Arquivos repassados por outras pessoas podem ter sofrido alterações maliciosas. O **único repositório oficial e verificado** do JustPokédex é:  
> 📦 **GitHub Repositório:** **[https://github.com/guilherme-se/justpokedex](https://github.com/guilherme-se/justpokedex)**

- **💻 Por que o Tampermonkey?**: Gerenciadores de UserScript dão controle total ao usuário. Você insere um script legível direto no navegador, podendo inspecionar o código a qualquer momento.
- **🔒 Execução 100% Local**: O script roda 100% no seu navegador (Client-Side). Nenhuma senha, token ou credencial é salva ou enviada para servidores externos.
- **🔍 Audite com IA ou Devs**: Por ser 100% Open-Source, incentivamos que você copie o código do repositório oficial e jogue em IAs como *ChatGPT, Claude ou Gemini*, ou peça para um desenvolvedor amigo auditar o script antes de instalar!

---

<div align="center">

JustPokédex UserScript — Desenvolvido para **Poké Idle World** © 2026

</div>
