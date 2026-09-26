<template>
  <main class="page">
    <div class="content">
      <p class="eyebrow">Платформа в разработке</p>
      <h1>Редактор схем организации дорожного движения</h1>
      <p class="intro">Подготовка схем на период текущих работ на железнодорожных переездах.</p>
      <p>
        Техническая основа приложения готова. Функции автономного редактора будут переноситься в Vue
        и TypeScript по этапам, с проверкой правил построения и формата проектов.
      </p>
    </div>
  </main>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem;
  background: #f5f7fa;
  color: #17212f;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    sans-serif;
}

.content {
  max-width: 46rem;
  padding: clamp(2rem, 5vw, 4rem);
  background: #fff;
  border: 1px solid #dce3eb;
  border-radius: 1rem;
}

.eyebrow {
  color: #185ca5;
  font-weight: 700;
}

h1 {
  font-size: clamp(2rem, 4vw, 3.25rem);
  line-height: 1.1;
}

p {
  font-size: 1.05rem;
  line-height: 1.65;
}

.intro {
  font-size: 1.25rem;
  font-weight: 600;
}
</style>
