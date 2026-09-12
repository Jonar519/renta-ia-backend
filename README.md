# renta-ia-backend

API REST, microservicios y pipeline de inteligencia artificial del **Sistema de Gestión Documental Contable con IA**.

> Este repositorio se construye en la **Fase 2 y 3** del plan de trabajo (estructura de carpetas, autenticación, endpoints, integración de IA). Por ahora contiene solo la configuración base.

## Depende de

- [`renta-ia-database`](../renta-ia-database): este backend se conecta a la base de datos definida y migrada en ese repositorio a través de Prisma. El `schema.prisma` de este repo debe reflejar exactamente las tablas creadas allí.

## Stack

- Node.js + TypeScript
- Express
- Prisma (ORM)
- BullMQ + Redis (cola de tareas para el pipeline de IA)
- JWT para autenticación

## Próximos pasos

Ver el plan completo de construcción — Fase 2 (backend base) y Fase 3 (integración de IA).
