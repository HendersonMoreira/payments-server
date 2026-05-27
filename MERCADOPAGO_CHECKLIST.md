# Checklist rapido Mercado Pago (1 minuto)

Use este fluxo antes de testar checkout no TioTV.

## 1) No painel do Mercado Pago

1. Entrar no Mercado Pago com a mesma conta do access token usado no backend.
2. Ir em `Seu negocio` > `Configuracoes` > `Dados da conta`.
3. Confirmar e-mail da conta ate ficar marcado como confirmado.
4. Ir em `Seu negocio` > `Cobrar com Mercado Pago` (ou `Checkout`) e concluir pendencias de cadastro/faturamento.
5. Validar que a conta pode receber cobrancas (`billing allow`).

## 2) Validar no backend (payments-server)

Com o servidor rodando, chamar:

- `GET /api/payments/mercadopago/account-status`

Exemplo local:

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/api/payments/mercadopago/account-status" -Method Get | ConvertTo-Json -Depth 10
```

Resultado esperado para liberar teste de checkout:

- `checks.confirmedEmail.value = true`
- `checks.billingAllow.value = true`
- `readyForCheckout = true`

Se `billingAllow` vier `null`, o schema da conta pode nao expor esse campo pela API. Nesse caso, use o painel do MP como fonte oficial e reteste o checkout.

## 3) Teste final

1. Chamar `POST /api/payments/pagbank/checkout`.
2. Abrir `paymentUrl` retornada.
3. Finalizar pagamento de teste com usuario/cartao de teste do MP.
4. Chamar `POST /api/payments/pagbank/verify` para confirmar ativacao premium.
