# OpenCode: alternar entre Zen e cli_proxy

## Objetivo e escopo

Uma sessão iniciada com `jev-opencode` deve permitir alternar entre modelos de `opencode/`, `opencode-go/` e `cli_proxy/`, inclusive em agentes auxiliares, com as chamadas de inferência passando pelo Jev Gateway. Esta entrega cobre esses providers, não todos os providers instalados no OpenCode. Não modifica os arquivos de configuração ou de autenticação do usuário e não exige push.

## Arquitetura

O launcher identifica o `baseURL` original de `cli_proxy` nas configurações efetivas do OpenCode e inicia dois processos independentes: o gateway Zen no endereço habitual (`JEV_OPENCODE_PORT`, padrão `8791`), com upstream `https://opencode.ai/zen/v1`, e o gateway `cli_proxy` numa segunda porta configurável, com upstream igual ao `baseURL` original (nesta máquina, `http://127.0.0.1:8317/v1`). Cada processo conserva o upstream fixo. O launcher só injeta overrides de endereço em `OPENCODE_CONFIG_CONTENT`; modelos, credenciais e escolhas de agentes permanecem com o OpenCode. O destino nunca é escolhido pelo nome do modelo dentro de um único proxy.

O suporte dual é ativado quando `cli_proxy` tem configuração compatível com `@ai-sdk/openai-compatible` e endereço HTTP resolvível, e não há override explícito de modelo/upstream que exija o comportamento anterior. Sem essa condição, `jev-opencode` mantém seu fluxo existente. O endereço original é lido antes da injeção para evitar criar um ciclo gateway → gateway. Se o endereço já aponta para um gateway e não se conhece o upstream real, o launcher não deve inventá-lo: informa como defini-lo explicitamente ou deixa esse provider fora do redirecionamento. Os overrides por modelo necessários ao OpenCode v2 também se aplicam aos modelos Zen/Go e `cli_proxy`, sem copiar chaves do catálogo.

## Operação e segurança

`--start` inicia/verifica as duas instâncias quando o modo dual está ativo. `--status` informa os dois destinos; `--stop` encerra apenas os roteadores pertencentes ao launcher. `--dashboard` inclui a porta adicional e `--print-config` mostra os endereços correspondentes. Se uma porta já estiver ocupada por um gateway de outro upstream, o launcher informa o conflito e não inicia o OpenCode com um override incorreto. Erros na decisão do Jev continuam seguindo o fluxo de passthrough do gateway.

Cada cliente envia sua própria credencial ao gateway associado; a chave de Zen não é copiada para `cli_proxy`, nem a chave de `cli_proxy` para Zen. O launcher não grava credenciais ou conversas. Não há roteamento com destino fornecido pelo cliente, nem proxy aberto a endereços arbitrários. A segunda porta permanece no loopback. O modo manual sem launcher pode exigir que o usuário informe o upstream original antes de alterar seu `baseURL`.

## Verificação e documentação

Testes sem rede e sem chaves reais cobrem detecção do `cli_proxy`, alternância entre os dois destinos, configuração v1/v2, credenciais não incluídas no override, colisão de upstream, ciclo de vida e a permanência do comportamento antigo quando só um provider é usado. Um teste de integração com upstreams locais falsos verifica que requisições dos dois modelos chegam aos destinos distintos. Atualizar o README e as variáveis de exemplo para explicar a segunda porta, os comandos de operação e os limites de compatibilidade. Não executar push.
